import chalk from "chalk";
import { exec } from "child_process";
import debug from "debug";
import fsExtra from "fs-extra";
import path from "path";
import semver from "semver";

import {
  Artifacts as ArtifactsImpl,
  getArtifactFromContractOutput,
} from "../internal/artifacts";
import { subtask, task, types } from "../internal/core/config/config-env";
import { assertHardhatInvariant, HardhatError } from "../internal/core/errors";
import { ERRORS } from "../internal/core/errors-list";
import {
  createCompilationJobFromFile,
  createCompilationJobsFromConnectedComponent,
  mergeCompilationJobsWithoutBug,
} from "../internal/solidity/compilation-job";
import { Compiler, NativeCompiler } from "../internal/solidity/compiler";
import { getInputFromCompilationJob } from "../internal/solidity/compiler/compiler-input";
import {
  CompilerDownloader,
  CompilerPlatform,
} from "../internal/solidity/compiler/downloader";
import { DependencyGraph } from "../internal/solidity/dependencyGraph";
import { Parser } from "../internal/solidity/parse";
import { ResolvedFile, Resolver } from "../internal/solidity/resolver";
import { glob } from "../internal/util/glob";
import { getCompilersDir } from "../internal/util/global-dir";
import { pluralize } from "../internal/util/strings";
import { Artifacts, CompilerInput, CompilerOutput, SolcBuild } from "../types";
import * as taskTypes from "../types/builtin-tasks";
import {
  CompilationJob,
  CompilationJobCreationError,
  CompilationJobCreationErrorReason,
  CompilationJobsCreationResult,
} from "../types/builtin-tasks";
import { getFullyQualifiedName } from "../utils/contract-names";
import { localPathToSourceName } from "../utils/source-names";

import {
  TASK_COMPILE,
  TASK_COMPILE_GET_COMPILATION_TASKS,
  TASK_COMPILE_SOLIDITY,
  TASK_COMPILE_SOLIDITY_CHECK_ERRORS,
  TASK_COMPILE_SOLIDITY_COMPILE,
  TASK_COMPILE_SOLIDITY_COMPILE_JOB,
  TASK_COMPILE_SOLIDITY_COMPILE_JOBS,
  TASK_COMPILE_SOLIDITY_COMPILE_SOLC,
  TASK_COMPILE_SOLIDITY_EMIT_ARTIFACTS,
  TASK_COMPILE_SOLIDITY_FILTER_COMPILATION_JOBS,
  TASK_COMPILE_SOLIDITY_GET_ARTIFACT_FROM_COMPILATION_OUTPUT,
  TASK_COMPILE_SOLIDITY_GET_COMPILATION_JOB_FOR_FILE,
  TASK_COMPILE_SOLIDITY_GET_COMPILATION_JOBS,
  TASK_COMPILE_SOLIDITY_GET_COMPILATION_JOBS_FAILURE_REASONS,
  TASK_COMPILE_SOLIDITY_GET_COMPILER_INPUT,
  TASK_COMPILE_SOLIDITY_GET_DEPENDENCY_GRAPH,
  TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD,
  TASK_COMPILE_SOLIDITY_GET_SOURCE_NAMES,
  TASK_COMPILE_SOLIDITY_GET_SOURCE_PATHS,
  TASK_COMPILE_SOLIDITY_HANDLE_COMPILATION_JOBS_FAILURES,
  TASK_COMPILE_SOLIDITY_LOG_COMPILATION_ERRORS,
  TASK_COMPILE_SOLIDITY_LOG_COMPILATION_RESULT,
  TASK_COMPILE_SOLIDITY_LOG_DOWNLOAD_COMPILER_END,
  TASK_COMPILE_SOLIDITY_LOG_DOWNLOAD_COMPILER_START,
  TASK_COMPILE_SOLIDITY_LOG_NOTHING_TO_COMPILE,
  TASK_COMPILE_SOLIDITY_LOG_RUN_COMPILER_END,
  TASK_COMPILE_SOLIDITY_LOG_RUN_COMPILER_START,
  TASK_COMPILE_SOLIDITY_MERGE_COMPILATION_JOBS,
  TASK_COMPILE_SOLIDITY_READ_FILE,
  TASK_COMPILE_SOLIDITY_RUN_SOLC,
  TASK_COMPILE_SOLIDITY_RUN_SOLCJS,
} from "./task-names";
import {
  getSolidityFilesCachePath,
  SolidityFilesCache,
} from "./utils/solidity-files-cache";

type ArtifactsEmittedPerFile = Array<{
  file: taskTypes.ResolvedFile;
  artifactsEmitted: string[];
}>;

type ArtifactsEmittedPerJob = Array<{
  compilationJob: CompilationJob;
  artifactsEmittedPerFile: ArtifactsEmittedPerFile;
}>;

function isConsoleLogError(error: any): boolean {
  return (
    error.type === "TypeError" &&
    typeof error.message === "string" &&
    error.message.includes("log") &&
    error.message.includes("type(library console)")
  );
}

const log = debug("hardhat:core:tasks:compile");

const COMPILE_TASK_FIRST_SOLC_VERSION_SUPPORTED = "0.4.11";

/**
 * Returns a list of absolute paths to all the solidity files in the project.
 * This list doesn't include dependencies, for example solidity files inside
 * node_modules.
 *
 * This is the right task to override to change how the solidity files of the
 * project are obtained.
 */
subtask(
  TASK_COMPILE_SOLIDITY_GET_SOURCE_PATHS,
  async (_, { config }): Promise<string[]> => {
    const paths = await glob(path.join(config.paths.sources, "**/*.sol"));

    return paths;
  }
);

/**
 * Receives a list of absolute paths and returns a list of source names
 * corresponding to each path. For example, receives
 * ["/home/user/project/contracts/Foo.sol"] and returns
 * ["contracts/Foo.sol"]. These source names will be used when the solc input
 * is generated.
 */
subtask(TASK_COMPILE_SOLIDITY_GET_SOURCE_NAMES)
  .addParam("sourcePaths", undefined, undefined, types.any)
  .setAction(
    async (
      { sourcePaths }: { sourcePaths: string[] },
      { config }
    ): Promise<string[]> => {
      const sourceNames = await Promise.all(
        sourcePaths.map((p) => localPathToSourceName(config.paths.root, p))
      );

      return sourceNames;
    }
  );

subtask(TASK_COMPILE_SOLIDITY_READ_FILE)
  .addParam("absolutePath", undefined, undefined, types.string)
  .setAction(
    async ({ absolutePath }: { absolutePath: string }): Promise<string> => {
      const content = await fsExtra.readFile(absolutePath, {
        encoding: "utf8",
      });

      return content;
    }
  );

/**
 * Receives a list of source names and returns a dependency graph. This task
 * is responsible for both resolving dependencies (like getting files from
 * node_modules) and generating the graph.
 */
subtask(TASK_COMPILE_SOLIDITY_GET_DEPENDENCY_GRAPH)
  .addParam("sourceNames", undefined, undefined, types.any)
  .addOptionalParam("solidityFilesCache", undefined, undefined, types.any)
  .setAction(
    async (
      {
        sourceNames,
        solidityFilesCache,
      }: { sourceNames: string[]; solidityFilesCache?: SolidityFilesCache },
      { config, run }
    ): Promise<taskTypes.DependencyGraph> => {
      const parser = new Parser(solidityFilesCache);
      const resolver = new Resolver(
        config.paths.root,
        parser,
        (absolutePath: string) =>
          run(TASK_COMPILE_SOLIDITY_READ_FILE, { absolutePath })
      );

      const resolvedFiles = await Promise.all(
        sourceNames.map((sn) => resolver.resolveSourceName(sn))
      );
      const dependencyGraph = await DependencyGraph.createFromResolvedFiles(
        resolver,
        resolvedFiles
      );

      return dependencyGraph;
    }
  );

/**
 * Receives a dependency graph and a file in it, and returns the compilation
 * job for that file. The compilation job should have everything that is
 * necessary to compile that file: a compiler config to be used and a list of
 * files to use as input of the compilation.
 *
 * If the file cannot be compiled, a MatchingCompilerFailure should be
 * returned instead.
 *
 * This is the right task to override to change the compiler configuration.
 * For example, if you want to change the compiler settings when targetting
 * rinkeby, you could do something like this:
 *
 *   const compilationJob = await runSuper();
 *   if (config.network.name === 'rinkeby') {
 *     compilationJob.solidityConfig.settings = newSettings;
 *   }
 *   return compilationJob;
 *
 */
subtask(TASK_COMPILE_SOLIDITY_GET_COMPILATION_JOB_FOR_FILE)
  .addParam("dependencyGraph", undefined, undefined, types.any)
  .addParam("file", undefined, undefined, types.any)
  .addOptionalParam("solidityFilesCache", undefined, undefined, types.any)
  .setAction(
    async (
      {
        dependencyGraph,
        file,
      }: {
        dependencyGraph: taskTypes.DependencyGraph;
        file: taskTypes.ResolvedFile;
        solidityFilesCache?: SolidityFilesCache;
      },
      { config }
    ): Promise<CompilationJob | CompilationJobCreationError> => {
      return createCompilationJobFromFile(
        dependencyGraph,
        file,
        config.solidity
      );
    }
  );

/**
 * Receives a dependency graph and returns a tuple with two arrays. The first
 * array is a list of CompilationJobsSuccess, where each item has a list of
 * compilation jobs. The second array is a list of CompilationJobsFailure,
 * where each item has a list of files that couldn't be compiled, grouped by
 * the reason for the failure.
 */
subtask(TASK_COMPILE_SOLIDITY_GET_COMPILATION_JOBS)
  .addParam("dependencyGraph", undefined, undefined, types.any)
  .addOptionalParam("solidityFilesCache", undefined, undefined, types.any)
  .setAction(
    async (
      {
        dependencyGraph,
        solidityFilesCache,
      }: {
        dependencyGraph: taskTypes.DependencyGraph;
        solidityFilesCache?: SolidityFilesCache;
      },
      { run }
    ): Promise<CompilationJobsCreationResult> => {
      const connectedComponents = dependencyGraph.getConnectedComponents();

      log(
        `The dependency graph was divided in '${connectedComponents.length}' connected components`
      );

      const compilationJobsCreationResults = await Promise.all(
        connectedComponents.map((graph) =>
          createCompilationJobsFromConnectedComponent(
            graph,
            (file: taskTypes.ResolvedFile) =>
              run(TASK_COMPILE_SOLIDITY_GET_COMPILATION_JOB_FOR_FILE, {
                file,
                dependencyGraph,
                solidityFilesCache,
              })
          )
        )
      );

      let jobs: CompilationJob[] = [];
      let errors: CompilationJobCreationError[] = [];

      for (const result of compilationJobsCreationResults) {
        jobs = jobs.concat(result.jobs);
        errors = errors.concat(result.errors);
      }

      return { jobs, errors };
    }
  );

/**
 * Receives a list of compilation jobs and returns a new list where some of
 * the compilation jobs might've been removed.
 *
 * This task can be overriden to change the way the cache is used, or to use
 * a different approach to filtering out compilation jobs.
 */
subtask(TASK_COMPILE_SOLIDITY_FILTER_COMPILATION_JOBS)
  .addParam("compilationJobs", undefined, undefined, types.any)
  .addParam("force", undefined, undefined, types.boolean)
  .addOptionalParam("solidityFilesCache", undefined, undefined, types.any)
  .setAction(
    async ({
      compilationJobs,
      force,
      solidityFilesCache,
    }: {
      compilationJobs: CompilationJob[];
      force: boolean;
      solidityFilesCache?: SolidityFilesCache;
    }): Promise<CompilationJob[]> => {
      assertHardhatInvariant(
        solidityFilesCache !== undefined,
        "The implementation of this task needs a defined solidityFilesCache"
      );

      if (force) {
        log(`force flag enabled, not filtering`);
        return compilationJobs;
      }

      const neededCompilationJobs = compilationJobs.filter((job) =>
        needsCompilation(job, solidityFilesCache)
      );

      const jobsFilteredOutCount =
        compilationJobs.length - neededCompilationJobs.length;
      log(`'${jobsFilteredOutCount}' jobs were filtered out`);

      return neededCompilationJobs;
    }
  );

/**
 * Receives a list of compilation jobs and returns a new list where some of
 * the jobs might've been merged.
 */
subtask(TASK_COMPILE_SOLIDITY_MERGE_COMPILATION_JOBS)
  .addParam("compilationJobs", undefined, undefined, types.any)
  .setAction(
    async ({
      compilationJobs,
    }: {
      compilationJobs: CompilationJob[];
    }): Promise<CompilationJob[]> => {
      return mergeCompilationJobsWithoutBug(compilationJobs);
    }
  );

/**
 * Prints a message when there's nothing to compile.
 */
subtask(TASK_COMPILE_SOLIDITY_LOG_NOTHING_TO_COMPILE)
  .addParam("quiet", undefined, undefined, types.boolean)
  .setAction(async ({ quiet }: { quiet: boolean }) => {
    if (!quiet) {
      console.log("Nothing to compile");
    }
  });

/**
 * Receives a list of compilation jobs and sends each one to be compiled.
 */
subtask(TASK_COMPILE_SOLIDITY_COMPILE_JOBS)
  .addParam("compilationJobs", undefined, undefined, types.any)
  .addParam("quiet", undefined, undefined, types.boolean)
  .setAction(
    async (
      {
        compilationJobs,
        quiet,
      }: {
        compilationJobs: CompilationJob[];
        quiet: boolean;
      },
      { run }
    ): Promise<{ artifactsEmittedPerJob: ArtifactsEmittedPerJob }> => {
      if (compilationJobs.length === 0) {
        log(`No compilation jobs to compile`);
        await run(TASK_COMPILE_SOLIDITY_LOG_NOTHING_TO_COMPILE, { quiet });
        return { artifactsEmittedPerJob: [] };
      }

      // sort compilation jobs by compiler version
      const sortedCompilationJobs = compilationJobs
        .slice()
        .sort((job1, job2) => {
          return semver.compare(
            job1.getSolcConfig().version,
            job2.getSolcConfig().version
          );
        });

      log(`Compiling ${sortedCompilationJobs.length} jobs`);

      const artifactsEmittedPerJob: ArtifactsEmittedPerJob = [];
      for (let i = 0; i < sortedCompilationJobs.length; i++) {
        const compilationJob = sortedCompilationJobs[i];

        const { artifactsEmittedPerFile } = await run(
          TASK_COMPILE_SOLIDITY_COMPILE_JOB,
          {
            compilationJob,
            compilationJobs: sortedCompilationJobs,
            compilationJobIndex: i,
            quiet,
          }
        );

        artifactsEmittedPerJob.push({
          compilationJob,
          artifactsEmittedPerFile,
        });
      }

      return { artifactsEmittedPerJob };
    }
  );

/**
 * Receives a compilation job and returns a CompilerInput.
 *
 * It's not recommended to override this task to modify the solc
 * configuration, override
 * TASK_COMPILE_SOLIDITY_GET_COMPILATION_JOB_FOR_FILE instead.
 */
subtask(TASK_COMPILE_SOLIDITY_GET_COMPILER_INPUT)
  .addParam("compilationJob", undefined, undefined, types.any)
  .setAction(
    async ({
      compilationJob,
    }: {
      compilationJob: CompilationJob;
    }): Promise<CompilerInput> => {
      return getInputFromCompilationJob(compilationJob);
    }
  );

subtask(TASK_COMPILE_SOLIDITY_LOG_DOWNLOAD_COMPILER_START)
  .addParam("isCompilerDownloaded", undefined, undefined, types.boolean)
  .addParam("quiet", undefined, undefined, types.boolean)
  .addParam("solcVersion", undefined, undefined, types.string)
  .setAction(
    async ({
      isCompilerDownloaded,
      solcVersion,
    }: {
      isCompilerDownloaded: boolean;
      quiet: boolean;
      solcVersion: string;
    }) => {
      if (isCompilerDownloaded) {
        return;
      }

      console.log(`Downloading compiler ${solcVersion}`);
    }
  );

subtask(TASK_COMPILE_SOLIDITY_LOG_DOWNLOAD_COMPILER_END)
  .addParam("isCompilerDownloaded", undefined, undefined, types.boolean)
  .addParam("quiet", undefined, undefined, types.boolean)
  .addParam("solcVersion", undefined, undefined, types.string)
  .setAction(
    async ({}: {
      isCompilerDownloaded: boolean;
      quiet: boolean;
      solcVersion: string;
    }) => {}
  );

/**
 * Receives a solc version and returns a path to a solc binary or to a
 * downloaded solcjs module. It also returns a flag indicating if the returned
 * path corresponds to solc or solcjs.
 */
subtask(TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD)
  .addParam("quiet", undefined, undefined, types.boolean)
  .addParam("solcVersion", undefined, undefined, types.string)
  .setAction(
    async (
      {
        quiet,
        solcVersion,
      }: {
        quiet: boolean;
        solcVersion: string;
      },
      { run }
    ): Promise<SolcBuild> => {
      const compilersCache = await getCompilersDir();
      const downloader = new CompilerDownloader(compilersCache);

      const isCompilerDownloaded = await downloader.isCompilerDownloaded(
        solcVersion
      );

      const { longVersion, platform: desiredPlatform } =
        await downloader.getCompilerBuild(solcVersion);

      await run(TASK_COMPILE_SOLIDITY_LOG_DOWNLOAD_COMPILER_START, {
        solcVersion,
        isCompilerDownloaded,
        quiet,
      });

      let compilerPath: string | undefined;
      let platform: CompilerPlatform | undefined;
      let nativeBinaryFailed = false;

      const compilerPathResult = await downloader.getDownloadedCompilerPath(
        solcVersion
      );

      if (compilerPathResult === undefined) {
        if (desiredPlatform === CompilerPlatform.WASM) {
          // if we were trying to download solcjs and it failed, there's nothing
          // we can do
          throw new HardhatError(ERRORS.SOLC.CANT_GET_COMPILER, {
            version: solcVersion,
          });
        }

        nativeBinaryFailed = true;
      } else {
        compilerPath = compilerPathResult.compilerPath;

        // when using a native binary, check that it works correctly
        // it it doesn't, force the downloader to use solcjs
        if (compilerPathResult.platform !== CompilerPlatform.WASM) {
          log("Checking native solc binary");

          const solcBinaryWorks = await checkSolcBinary(
            compilerPathResult.compilerPath
          );
          if (!solcBinaryWorks) {
            log("Native solc binary doesn't work, using solcjs instead");
            nativeBinaryFailed = true;
          }
        }
      }

      if (nativeBinaryFailed) {
        const solcJsDownloader = new CompilerDownloader(compilersCache, {
          forceSolcJs: true,
        });

        const solcjsCompilerPath =
          await solcJsDownloader.getDownloadedCompilerPath(solcVersion);

        if (solcjsCompilerPath === undefined) {
          throw new HardhatError(ERRORS.SOLC.CANT_GET_COMPILER, {
            version: solcVersion,
          });
        }

        compilerPath = solcjsCompilerPath.compilerPath;
        platform = CompilerPlatform.WASM;
      }

      await run(TASK_COMPILE_SOLIDITY_LOG_DOWNLOAD_COMPILER_END, {
        solcVersion,
        isCompilerDownloaded,
        quiet,
      });

      const isSolcJs = platform === CompilerPlatform.WASM;

      assertHardhatInvariant(
        compilerPath !== undefined,
        "A compilerPath should be defined at this point"
      );

      return { compilerPath, isSolcJs, version: solcVersion, longVersion };
    }
  );

/**
 * Receives an absolute path to a solcjs module and the input to be compiled,
 * and returns the generated output
 */
subtask(TASK_COMPILE_SOLIDITY_RUN_SOLCJS)
  .addParam("input", undefined, undefined, types.any)
  .addParam("solcJsPath", undefined, undefined, types.string)
  .setAction(
    async ({
      input,
      solcJsPath,
    }: {
      input: CompilerInput;
      solcJsPath: string;
    }) => {
      const compiler = new Compiler(solcJsPath);

      const output = await compiler.compile(input);

      return output;
    }
  );

/**
 * Receives an absolute path to a solc binary and the input to be compiled,
 * and returns the generated output
 */
subtask(TASK_COMPILE_SOLIDITY_RUN_SOLC)
  .addParam("input", undefined, undefined, types.any)
  .addParam("solcPath", undefined, undefined, types.string)
  .setAction(
    async ({ input, solcPath }: { input: CompilerInput; solcPath: string }) => {
      const compiler = new NativeCompiler(solcPath);

      const output = await compiler.compile(input);

      return output;
    }
  );

/**
 * Receives a CompilerInput and a solc version, compiles the input using a native
 * solc binary or, if that's not possible, using solcjs. Returns the generated
 * output.
 *
 * This task can be overriden to change how solc is obtained or used.
 */
subtask(TASK_COMPILE_SOLIDITY_COMPILE_SOLC)
  .addParam("input", undefined, undefined, types.any)
  .addParam("quiet", undefined, undefined, types.boolean)
  .addParam("solcVersion", undefined, undefined, types.string)
  .addParam("compilationJob", undefined, undefined, types.any)
  .addParam("compilationJobs", undefined, undefined, types.any)
  .addParam("compilationJobIndex", undefined, undefined, types.int)
  .setAction(
    async (
      {
        input,
        quiet,
        solcVersion,
        compilationJob,
        compilationJobs,
        compilationJobIndex,
      }: {
        input: CompilerInput;
        quiet: boolean;
        solcVersion: string;
        compilationJob: CompilationJob;
        compilationJobs: CompilationJob[];
        compilationJobIndex: number;
      },
      { run }
    ): Promise<{ output: CompilerOutput; solcBuild: SolcBuild }> => {
      // versions older than 0.4.11 don't work with hardhat
      // see issue https://github.com/nomiclabs/hardhat/issues/2004
      if (semver.lt(solcVersion, COMPILE_TASK_FIRST_SOLC_VERSION_SUPPORTED)) {
        throw new HardhatError(
          ERRORS.BUILTIN_TASKS.COMPILE_TASK_UNSUPPORTED_SOLC_VERSION,
          {
            version: solcVersion,
            firstSupportedVersion: COMPILE_TASK_FIRST_SOLC_VERSION_SUPPORTED,
          }
        );
      }

      const solcBuild: SolcBuild = await run(
        TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD,
        {
          quiet,
          solcVersion,
        }
      );

      await run(TASK_COMPILE_SOLIDITY_LOG_RUN_COMPILER_START, {
        compilationJob,
        compilationJobs,
        compilationJobIndex,
        quiet,
      });

      let output;
      if (solcBuild.isSolcJs) {
        output = await run(TASK_COMPILE_SOLIDITY_RUN_SOLCJS, {
          input,
          solcJsPath: solcBuild.compilerPath,
        });
      } else {
        output = await run(TASK_COMPILE_SOLIDITY_RUN_SOLC, {
          input,
          solcPath: solcBuild.compilerPath,
        });
      }

      await run(TASK_COMPILE_SOLIDITY_LOG_RUN_COMPILER_END, {
        compilationJob,
        compilationJobs,
        compilationJobIndex,
        output,
        quiet,
      });

      return { output, solcBuild };
    }
  );

/**
 * This task is just a proxy to the task that compiles with solc.
 *
 * Override this to use a different task to compile a job.
 */
subtask(TASK_COMPILE_SOLIDITY_COMPILE, async (taskArgs: any, { run }) => {
  return run(TASK_COMPILE_SOLIDITY_COMPILE_SOLC, taskArgs);
});

/**
 * Receives a compilation output and prints its errors and any other
 * information useful to the user.
 */
subtask(TASK_COMPILE_SOLIDITY_LOG_COMPILATION_ERRORS)
  .addParam("output", undefined, undefined, types.any)
  .addParam("quiet", undefined, undefined, types.boolean)
  .setAction(async ({ output }: { output: any; quiet: boolean }) => {
    if (output?.errors === undefined) {
      return;
    }

    for (const error of output.errors) {
      if (error.severity === "error") {
        const errorMessage =
          getFormattedInternalCompilerErrorMessage(error) ??
          error.formattedMessage;

        console.error(chalk.red(errorMessage));
      } else {
        console.warn(chalk.yellow(error.formattedMessage));
      }
    }

    const hasConsoleErrors = output.errors.some(isConsoleLogError);
    if (hasConsoleErrors) {
      console.error(
        chalk.red(
          `The console.log call you made isn’t supported. See https://hardhat.org/console-log for the list of supported methods.`
        )
      );
      console.log();
    }
  });

/**
 * Receives a solc output and checks if there are errors. Throws if there are
 * errors.
 *
 * Override this task to avoid interrupting the compilation process if some
 * job has compilation errors.
 */
subtask(TASK_COMPILE_SOLIDITY_CHECK_ERRORS)
  .addParam("output", undefined, undefined, types.any)
  .addParam("quiet", undefined, undefined, types.boolean)
  .setAction(
    async ({ output, quiet }: { output: any; quiet: boolean }, { run }) => {
      await run(TASK_COMPILE_SOLIDITY_LOG_COMPILATION_ERRORS, {
        output,
        quiet,
      });

      if (hasCompilationErrors(output)) {
        throw new HardhatError(ERRORS.BUILTIN_TASKS.COMPILE_FAILURE);
      }
    }
  );

/**
 * Saves to disk the artifacts for a compilation job. These artifacts
 * include the main artifacts, the debug files, and the build info.
 */
subtask(TASK_COMPILE_SOLIDITY_EMIT_ARTIFACTS)
  .addParam("compilationJob", undefined, undefined, types.any)
  .addParam("input", undefined, undefined, types.any)
  .addParam("output", undefined, undefined, types.any)
  .addParam("solcBuild", undefined, undefined, types.any)
  .setAction(
    async (
      {
        compilationJob,
        input,
        output,
        solcBuild,
      }: {
        compilationJob: CompilationJob;
        input: CompilerInput;
        output: CompilerOutput;
        solcBuild: SolcBuild;
      },
      { artifacts, run }
    ): Promise<{
      artifactsEmittedPerFile: ArtifactsEmittedPerFile;
    }> => {
      const pathToBuildInfo = await artifacts.saveBuildInfo(
        compilationJob.getSolcConfig().version,
        solcBuild.longVersion,
        input,
        output
      );

      const artifactsEmittedPerFile: ArtifactsEmittedPerFile = [];
      for (const file of compilationJob.getResolvedFiles()) {
        log(`Emitting artifacts for file '${file.sourceName}'`);
        if (!compilationJob.emitsArtifacts(file)) {
          continue;
        }

        const artifactsEmitted = [];
        for (const [contractName, contractOutput] of Object.entries(
          output.contracts?.[file.sourceName] ?? {}
        )) {
          log(`Emitting artifact for contract '${contractName}'`);

          const artifact = await run(
            TASK_COMPILE_SOLIDITY_GET_ARTIFACT_FROM_COMPILATION_OUTPUT,
            {
              sourceName: file.sourceName,
              contractName,
              contractOutput,
            }
          );

          await artifacts.saveArtifactAndDebugFile(artifact, pathToBuildInfo);

          artifactsEmitted.push(artifact.contractName);
        }

        artifactsEmittedPerFile.push({
          file,
          artifactsEmitted,
        });
      }

      return { artifactsEmittedPerFile };
    }
  );

/**
 * Generates the artifact for contract `contractName` given its compilation
 * output.
 */
subtask(TASK_COMPILE_SOLIDITY_GET_ARTIFACT_FROM_COMPILATION_OUTPUT)
  .addParam("sourceName", undefined, undefined, types.string)
  .addParam("contractName", undefined, undefined, types.string)
  .addParam("contractOutput", undefined, undefined, types.any)
  .setAction(
    async ({
      sourceName,
      contractName,
      contractOutput,
    }: {
      sourceName: string;
      contractName: string;
      contractOutput: any;
    }): Promise<any> => {
      return getArtifactFromContractOutput(
        sourceName,
        contractName,
        contractOutput
      );
    }
  );

/**
 * Prints a message before running soljs with some input.
 */
subtask(TASK_COMPILE_SOLIDITY_LOG_RUN_COMPILER_START)
  .addParam("compilationJob", undefined, undefined, types.any)
  .addParam("compilationJobs", undefined, undefined, types.any)
  .addParam("compilationJobIndex", undefined, undefined, types.int)
  .addParam("quiet", undefined, undefined, types.boolean)
  .setAction(
    async ({
      compilationJobs,
      compilationJobIndex,
    }: {
      compilationJob: CompilationJob;
      compilationJobs: CompilationJob[];
      compilationJobIndex: number;
    }) => {
      const solcVersion =
        compilationJobs[compilationJobIndex].getSolcConfig().version;

      // we log if this is the first job, or if the previous job has a
      // different solc version
      const shouldLog =
        compilationJobIndex === 0 ||
        compilationJobs[compilationJobIndex - 1].getSolcConfig().version !==
          solcVersion;

      if (!shouldLog) {
        return;
      }

      // count how many files emit artifacts for this version
      let count = 0;
      for (let i = compilationJobIndex; i < compilationJobs.length; i++) {
        const job = compilationJobs[i];
        if (job.getSolcConfig().version !== solcVersion) {
          break;
        }

        count += job
          .getResolvedFiles()
          .filter((file) => job.emitsArtifacts(file)).length;
      }

      console.log(
        `Compiling ${count} ${pluralize(count, "file")} with ${solcVersion}`
      );
    }
  );

/**
 * Prints a message after compiling some input
 */
subtask(TASK_COMPILE_SOLIDITY_LOG_RUN_COMPILER_END)
  .addParam("compilationJob", undefined, undefined, types.any)
  .addParam("compilationJobs", undefined, undefined, types.any)
  .addParam("compilationJobIndex", undefined, undefined, types.int)
  .addParam("output", undefined, undefined, types.any)
  .addParam("quiet", undefined, undefined, types.boolean)
  .setAction(
    async ({}: {
      compilationJob: CompilationJob;
      compilationJobs: CompilationJob[];
      compilationJobIndex: number;
      output: any;
      quiet: boolean;
    }) => {}
  );

/**
 * This is an orchestrator task that uses other subtasks to compile a
 * compilation job.
 */
subtask(TASK_COMPILE_SOLIDITY_COMPILE_JOB)
  .addParam("compilationJob", undefined, undefined, types.any)
  .addParam("compilationJobs", undefined, undefined, types.any)
  .addParam("compilationJobIndex", undefined, undefined, types.int)
  .addParam("quiet", undefined, undefined, types.boolean)
  .addOptionalParam("emitsArtifacts", undefined, true, types.boolean)
  .setAction(
    async (
      {
        compilationJob,
        compilationJobs,
        compilationJobIndex,
        quiet,
        emitsArtifacts,
      }: {
        compilationJob: CompilationJob;
        compilationJobs: CompilationJob[];
        compilationJobIndex: number;
        quiet: boolean;
        emitsArtifacts: boolean;
      },
      { run }
    ): Promise<{
      artifactsEmittedPerFile: ArtifactsEmittedPerFile;
      compilationJob: taskTypes.CompilationJob;
      input: CompilerInput;
      output: CompilerOutput;
      solcBuild: any;
    }> => {
      log(
        `Compiling job with version '${compilationJob.getSolcConfig().version}'`
      );
      const input: CompilerInput = await run(
        TASK_COMPILE_SOLIDITY_GET_COMPILER_INPUT,
        {
          compilationJob,
        }
      );

      const { output, solcBuild } = await run(TASK_COMPILE_SOLIDITY_COMPILE, {
        solcVersion: compilationJob.getSolcConfig().version,
        input,
        quiet,
        compilationJob,
        compilationJobs,
        compilationJobIndex,
      });

      await run(TASK_COMPILE_SOLIDITY_CHECK_ERRORS, { output, quiet });

      let artifactsEmittedPerFile = [];
      if (emitsArtifacts) {
        artifactsEmittedPerFile = (
          await run(TASK_COMPILE_SOLIDITY_EMIT_ARTIFACTS, {
            compilationJob,
            input,
            output,
            solcBuild,
          })
        ).artifactsEmittedPerFile;
      }

      return {
        artifactsEmittedPerFile,
        compilationJob,
        input,
        output,
        solcBuild,
      };
    }
  );

/**
 * Receives a list of CompilationJobsFailure and throws an error if it's not
 * empty.
 *
 * This task could be overriden to avoid interrupting the compilation if
 * there's some part of the project that can't be compiled.
 */
subtask(TASK_COMPILE_SOLIDITY_HANDLE_COMPILATION_JOBS_FAILURES)
  .addParam("compilationJobsCreationErrors", undefined, undefined, types.any)
  .setAction(
    async (
      {
        compilationJobsCreationErrors,
      }: {
        compilationJobsCreationErrors: CompilationJobCreationError[];
      },
      { run }
    ) => {
      const hasErrors = compilationJobsCreationErrors.length > 0;

      if (hasErrors) {
        log(`There were errors creating the compilation jobs, throwing`);
        const reasons: string = await run(
          TASK_COMPILE_SOLIDITY_GET_COMPILATION_JOBS_FAILURE_REASONS,
          { compilationJobsCreationErrors }
        );

        throw new HardhatError(
          ERRORS.BUILTIN_TASKS.COMPILATION_JOBS_CREATION_FAILURE,
          {
            reasons,
          }
        );
      }
    }
  );

/**
 * Receives a list of CompilationJobsFailure and returns an error message
 * that describes the failure.
 */
subtask(TASK_COMPILE_SOLIDITY_GET_COMPILATION_JOBS_FAILURE_REASONS)
  .addParam("compilationJobsCreationErrors", undefined, undefined, types.any)
  .setAction(
    async ({
      compilationJobsCreationErrors: errors,
    }: {
      compilationJobsCreationErrors: CompilationJobCreationError[];
    }): Promise<string> => {
      const noCompatibleSolc: CompilationJobCreationError[] = [];
      const incompatibleOverridenSolc: CompilationJobCreationError[] = [];
      const directlyImportsIncompatibleFile: CompilationJobCreationError[] = [];
      const indirectlyImportsIncompatibleFile: CompilationJobCreationError[] =
        [];
      const other: CompilationJobCreationError[] = [];

      for (const error of errors) {
        if (
          error.reason ===
          CompilationJobCreationErrorReason.NO_COMPATIBLE_SOLC_VERSION_FOUND
        ) {
          noCompatibleSolc.push(error);
        } else if (
          error.reason ===
          CompilationJobCreationErrorReason.INCOMPATIBLE_OVERRIDEN_SOLC_VERSION
        ) {
          incompatibleOverridenSolc.push(error);
        } else if (
          error.reason ===
          CompilationJobCreationErrorReason.DIRECTLY_IMPORTS_INCOMPATIBLE_FILE
        ) {
          directlyImportsIncompatibleFile.push(error);
        } else if (
          error.reason ===
          CompilationJobCreationErrorReason.INDIRECTLY_IMPORTS_INCOMPATIBLE_FILE
        ) {
          indirectlyImportsIncompatibleFile.push(error);
        } else if (
          error.reason === CompilationJobCreationErrorReason.OTHER_ERROR
        ) {
          other.push(error);
        } else {
          // add unrecognized errors to `other`
          other.push(error);
        }
      }

      let errorMessage = "";
      if (incompatibleOverridenSolc.length > 0) {
        errorMessage += `The compiler version for the following files is fixed through an override in your config file to a version that is incompatible with their Solidity version pragmas.

`;

        for (const error of incompatibleOverridenSolc) {
          const { sourceName } = error.file;
          const { versionPragmas } = error.file.content;
          const versionsRange = versionPragmas.join(" ");

          log(`File ${sourceName} has an incompatible overriden compiler`);

          errorMessage += `  * ${sourceName} (${versionsRange})\n`;
        }

        errorMessage += "\n";
      }

      if (noCompatibleSolc.length > 0) {
        errorMessage += `The Solidity version pragma statement in these files don't match any of the configured compilers in your config. Change the pragma or configure additional compiler versions in your hardhat config.

`;

        for (const error of noCompatibleSolc) {
          const { sourceName } = error.file;
          const { versionPragmas } = error.file.content;
          const versionsRange = versionPragmas.join(" ");

          log(
            `File ${sourceName} doesn't match any of the configured compilers`
          );

          errorMessage += `  * ${sourceName} (${versionsRange})\n`;
        }

        errorMessage += "\n";
      }

      if (directlyImportsIncompatibleFile.length > 0) {
        errorMessage += `These files import other files that use a different and incompatible version of Solidity:

`;

        for (const error of directlyImportsIncompatibleFile) {
          const { sourceName } = error.file;
          const { versionPragmas } = error.file.content;
          const versionsRange = versionPragmas.join(" ");

          const incompatibleDirectImportsFiles: ResolvedFile[] =
            error.extra?.incompatibleDirectImports ?? [];

          const incompatibleDirectImports = incompatibleDirectImportsFiles.map(
            (x: ResolvedFile) =>
              `${x.sourceName} (${x.content.versionPragmas.join(" ")})`
          );

          log(
            `File ${sourceName} imports files ${incompatibleDirectImportsFiles
              .map((x) => x.sourceName)
              .join(", ")} that use an incompatible version of Solidity`
          );

          let directImportsText = "";
          if (incompatibleDirectImports.length === 1) {
            directImportsText = ` imports ${incompatibleDirectImports[0]}`;
          } else if (incompatibleDirectImports.length === 2) {
            directImportsText = ` imports ${incompatibleDirectImports[0]} and ${incompatibleDirectImports[1]}`;
          } else if (incompatibleDirectImports.length > 2) {
            const otherImportsCount = incompatibleDirectImports.length - 2;
            directImportsText = ` imports ${incompatibleDirectImports[0]}, ${
              incompatibleDirectImports[1]
            } and ${otherImportsCount} other ${pluralize(
              otherImportsCount,
              "file"
            )}. Use --verbose to see the full list.`;
          }

          errorMessage += `  * ${sourceName} (${versionsRange})${directImportsText}\n`;
        }

        errorMessage += "\n";
      }

      if (indirectlyImportsIncompatibleFile.length > 0) {
        errorMessage += `These files depend on other files that use a different and incompatible version of Solidity:

`;

        for (const error of indirectlyImportsIncompatibleFile) {
          const { sourceName } = error.file;
          const { versionPragmas } = error.file.content;
          const versionsRange = versionPragmas.join(" ");

          const incompatibleIndirectImports: taskTypes.TransitiveDependency[] =
            error.extra?.incompatibleIndirectImports ?? [];

          const incompatibleImports = incompatibleIndirectImports.map(
            ({ dependency }) =>
              `${
                dependency.sourceName
              } (${dependency.content.versionPragmas.join(" ")})`
          );

          for (const {
            dependency,
            path: dependencyPath,
          } of incompatibleIndirectImports) {
            const dependencyPathText = [
              sourceName,
              ...dependencyPath.map((x) => x.sourceName),
              dependency.sourceName,
            ].join(" -> ");

            log(
              `File ${sourceName} depends on file ${dependency.sourceName} that uses an incompatible version of Solidity
The dependency path is ${dependencyPathText}
`
            );
          }

          let indirectImportsText = "";
          if (incompatibleImports.length === 1) {
            indirectImportsText = ` depends on ${incompatibleImports[0]}`;
          } else if (incompatibleImports.length === 2) {
            indirectImportsText = ` depends on ${incompatibleImports[0]} and ${incompatibleImports[1]}`;
          } else if (incompatibleImports.length > 2) {
            const otherImportsCount = incompatibleImports.length - 2;
            indirectImportsText = ` depends on ${incompatibleImports[0]}, ${
              incompatibleImports[1]
            } and ${otherImportsCount} other ${pluralize(
              otherImportsCount,
              "file"
            )}. Use --verbose to see the full list.`;
          }

          errorMessage += `  * ${sourceName} (${versionsRange})${indirectImportsText}\n`;
        }

        errorMessage += "\n";
      }

      if (other.length > 0) {
        errorMessage += `These files and its dependencies cannot be compiled with your config. This can happen because they have incompatible Solidity pragmas, or don't match any of your configured Solidity compilers.

${other.map((x) => `  * ${x.file.sourceName}`).join("\n")}

`;
      }

      errorMessage += `To learn more, run the command again with --verbose

Read about compiler configuration at https://hardhat.org/config
`;

      return errorMessage;
    }
  );

subtask(TASK_COMPILE_SOLIDITY_LOG_COMPILATION_RESULT)
  .addParam("compilationJobs", undefined, undefined, types.any)
  .addParam("quiet", undefined, undefined, types.boolean)
  .setAction(
    async ({ compilationJobs }: { compilationJobs: CompilationJob[] }) => {
      if (compilationJobs.length > 0) {
        console.log("Compilation finished successfully");
      }
    }
  );

/**
 * Main task for compiling the solidity files in the project.
 *
 * The main responsibility of this task is to orchestrate and connect most of
 * the subtasks related to compiling solidity.
 */
subtask(TASK_COMPILE_SOLIDITY)
  .addParam("force", undefined, undefined, types.boolean)
  .addParam("quiet", undefined, undefined, types.boolean)
  .setAction(
    async (
      { force, quiet }: { force: boolean; quiet: boolean },
      { artifacts, config, run }
    ) => {
      const sourcePaths: string[] = await run(
        TASK_COMPILE_SOLIDITY_GET_SOURCE_PATHS
      );

      const sourceNames: string[] = await run(
        TASK_COMPILE_SOLIDITY_GET_SOURCE_NAMES,
        {
          sourcePaths,
        }
      );

      const solidityFilesCachePath = getSolidityFilesCachePath(config.paths);
      let solidityFilesCache = await SolidityFilesCache.readFromFile(
        solidityFilesCachePath
      );

      const dependencyGraph: taskTypes.DependencyGraph = await run(
        TASK_COMPILE_SOLIDITY_GET_DEPENDENCY_GRAPH,
        { sourceNames, solidityFilesCache }
      );

      solidityFilesCache = await invalidateCacheMissingArtifacts(
        solidityFilesCache,
        artifacts,
        dependencyGraph.getResolvedFiles()
      );

      const compilationJobsCreationResult: CompilationJobsCreationResult =
        await run(TASK_COMPILE_SOLIDITY_GET_COMPILATION_JOBS, {
          dependencyGraph,
          solidityFilesCache,
        });

      await run(TASK_COMPILE_SOLIDITY_HANDLE_COMPILATION_JOBS_FAILURES, {
        compilationJobsCreationErrors: compilationJobsCreationResult.errors,
      });

      const compilationJobs = compilationJobsCreationResult.jobs;

      const filteredCompilationJobs: CompilationJob[] = await run(
        TASK_COMPILE_SOLIDITY_FILTER_COMPILATION_JOBS,
        { compilationJobs, force, solidityFilesCache }
      );

      const mergedCompilationJobs: CompilationJob[] = await run(
        TASK_COMPILE_SOLIDITY_MERGE_COMPILATION_JOBS,
        { compilationJobs: filteredCompilationJobs }
      );

      const {
        artifactsEmittedPerJob,
      }: { artifactsEmittedPerJob: ArtifactsEmittedPerJob } = await run(
        TASK_COMPILE_SOLIDITY_COMPILE_JOBS,
        {
          compilationJobs: mergedCompilationJobs,
          quiet,
        }
      );

      // update cache using the information about the emitted artifacts
      for (const {
        compilationJob: compilationJob,
        artifactsEmittedPerFile: artifactsEmittedPerFile,
      } of artifactsEmittedPerJob) {
        for (const { file, artifactsEmitted } of artifactsEmittedPerFile) {
          solidityFilesCache.addFile(file.absolutePath, {
            lastModificationDate: file.lastModificationDate.valueOf(),
            contentHash: file.contentHash,
            sourceName: file.sourceName,
            solcConfig: compilationJob.getSolcConfig(),
            imports: file.content.imports,
            versionPragmas: file.content.versionPragmas,
            artifacts: artifactsEmitted,
          });
        }
      }

      const allArtifactsEmittedPerFile = solidityFilesCache.getEntries();

      // We know this is the actual implementation, so we use some
      // non-public methods here.
      const artifactsImpl = artifacts as ArtifactsImpl;
      await artifactsImpl.removeObsoleteArtifacts(allArtifactsEmittedPerFile);
      await artifactsImpl.removeObsoleteBuildInfos();

      await solidityFilesCache.writeToFile(solidityFilesCachePath);

      await run(TASK_COMPILE_SOLIDITY_LOG_COMPILATION_RESULT, {
        compilationJobs: mergedCompilationJobs,
        quiet,
      });
    }
  );

/**
 * Returns a list of compilation tasks.
 *
 * This is the task to override to add support for other languages.
 */
subtask(TASK_COMPILE_GET_COMPILATION_TASKS, async (): Promise<string[]> => {
  return [TASK_COMPILE_SOLIDITY];
});

/**
 * Main compile task.
 *
 * This is a meta-task that just gets all the compilation tasks and runs them.
 * Right now there's only a "compile solidity" task.
 */
task(TASK_COMPILE, "Compiles the entire project, building all artifacts")
  .addFlag("force", "Force compilation ignoring cache")
  .addFlag("quiet", "Makes the compilation process less verbose")
  .setAction(async (compilationArgs: any, { run }) => {
    const compilationTasks: string[] = await run(
      TASK_COMPILE_GET_COMPILATION_TASKS
    );

    for (const compilationTask of compilationTasks) {
      await run(compilationTask, compilationArgs);
    }
  });

/**
 * If a file is present in the cache, but some of its artifacts are missing on
 * disk, we remove it from the cache to force it to be recompiled.
 */
async function invalidateCacheMissingArtifacts(
  solidityFilesCache: SolidityFilesCache,
  artifacts: Artifacts,
  resolvedFiles: ResolvedFile[]
): Promise<SolidityFilesCache> {
  for (const file of resolvedFiles) {
    const cacheEntry = solidityFilesCache.getEntry(file.absolutePath);

    if (cacheEntry === undefined) {
      continue;
    }

    const { artifacts: emittedArtifacts } = cacheEntry;

    for (const emittedArtifact of emittedArtifacts) {
      const artifactExists = await artifacts.artifactExists(
        getFullyQualifiedName(file.sourceName, emittedArtifact)
      );
      if (!artifactExists) {
        log(
          `Invalidate cache for '${file.absolutePath}' because artifact '${emittedArtifact}' doesn't exist`
        );
        solidityFilesCache.removeEntry(file.absolutePath);
        break;
      }
    }
  }

  return solidityFilesCache;
}

/**
 * Checks if the given compilation job needs to be done.
 */
function needsCompilation(
  job: taskTypes.CompilationJob,
  cache: SolidityFilesCache
): boolean {
  for (const file of job.getResolvedFiles()) {
    const hasChanged = cache.hasFileChanged(
      file.absolutePath,
      file.contentHash,
      // we only check if the solcConfig is different for files that
      // emit artifacts
      job.emitsArtifacts(file) ? job.getSolcConfig() : undefined
    );

    if (hasChanged) {
      return true;
    }
  }

  return false;
}

function hasCompilationErrors(output: any): boolean {
  return (
    output.errors && output.errors.some((x: any) => x.severity === "error")
  );
}

async function checkSolcBinary(solcPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const process = exec(`${solcPath} --version`);
    process.on("exit", (code) => {
      resolve(code === 0);
    });
  });
}

/**
 * This function returns a properly formatted Internal Compiler Error message.
 *
 * This is present due to a bug in Solidity. See: https://github.com/ethereum/solidity/issues/9926
 *
 * If the error is not an ICE, or if it's properly formatted, this function returns undefined.
 */
function getFormattedInternalCompilerErrorMessage(error: {
  formattedMessage: string;
  message: string;
  type: string;
}): string | undefined {
  if (error.formattedMessage.trim() !== "InternalCompilerError:") {
    return;
  }

  // We trim any final `:`, as we found some at the end of the error messages,
  // and then trim just in case a blank space was left
  return `${error.type}: ${error.message}`.replace(/[:\s]*$/g, "").trim();
}
