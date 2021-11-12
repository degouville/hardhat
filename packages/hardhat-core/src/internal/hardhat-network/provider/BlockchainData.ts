import { Block } from "@ethereumjs/block";
import { TypedTransaction } from "@ethereumjs/tx";
import Bloom from "@ethereumjs/vm/dist/bloom";
import { BN, bufferToHex } from "ethereumjs-util";

import { bloomFilter, filterLogs } from "./filter";
import { EmptyBlockRange, FilterParams } from "./node-types";
import { RpcLogOutput, RpcReceiptOutput } from "./output";

export class BlockchainData {
  private _blocksByNumber: Map<number, Block> = new Map();
  private _blocksByHash: Map<string, Block> = new Map();
  private _blocksByTransactions: Map<string, Block> = new Map();
  private _transactions: Map<string, TypedTransaction> = new Map();
  private _transactionReceipts: Map<string, RpcReceiptOutput> = new Map();
  private _totalDifficulty: Map<string, BN> = new Map();
  public emptyBlockRanges: EmptyBlockRange[] = new Array();

  public addEmptyBlockRange(r: EmptyBlockRange) {
    this.emptyBlockRanges.push(r);
  }

  public getBlockByNumber(blockNumber: BN) {
    return this._blocksByNumber.get(blockNumber.toNumber());
  }

  public getBlockByHash(blockHash: Buffer) {
    return this._blocksByHash.get(bufferToHex(blockHash));
  }

  public getBlockByTransactionHash(transactionHash: Buffer) {
    return this._blocksByTransactions.get(bufferToHex(transactionHash));
  }

  public getTransaction(transactionHash: Buffer) {
    return this._transactions.get(bufferToHex(transactionHash));
  }

  public getTransactionReceipt(transactionHash: Buffer) {
    return this._transactionReceipts.get(bufferToHex(transactionHash));
  }

  public getTotalDifficulty(blockHash: Buffer) {
    return this._totalDifficulty.get(bufferToHex(blockHash));
  }

  public getLogs(filterParams: FilterParams) {
    const logs: RpcLogOutput[] = [];
    for (
      let i = filterParams.fromBlock;
      i.lte(filterParams.toBlock);
      i = i.addn(1)
    ) {
      const block = this.getBlockByNumber(i);
      if (
        block === undefined ||
        !bloomFilter(
          new Bloom(block.header.bloom),
          filterParams.addresses,
          filterParams.normalizedTopics
        )
      ) {
        continue;
      }
      for (const transaction of block.transactions) {
        const receipt = this.getTransactionReceipt(transaction.hash());
        if (receipt !== undefined) {
          logs.push(
            ...filterLogs(receipt.logs, {
              fromBlock: filterParams.fromBlock,
              toBlock: filterParams.toBlock,
              addresses: filterParams.addresses,
              normalizedTopics: filterParams.normalizedTopics,
            })
          );
        }
      }
    }
    return logs;
  }

  public addBlock(block: Block, totalDifficulty: BN) {
    const blockHash = bufferToHex(block.hash());
    const blockNumber = new BN(block.header.number).toNumber();
    this._blocksByNumber.set(blockNumber, block);
    this._blocksByHash.set(blockHash, block);
    this._totalDifficulty.set(blockHash, totalDifficulty);

    for (const transaction of block.transactions) {
      const transactionHash = bufferToHex(transaction.hash());
      this._transactions.set(transactionHash, transaction);
      this._blocksByTransactions.set(transactionHash, block);
    }
  }

  public removeBlock(block: Block) {
    const blockHash = bufferToHex(block.hash());
    const blockNumber = new BN(block.header.number).toNumber();
    this._blocksByNumber.delete(blockNumber);
    this._blocksByHash.delete(blockHash);
    this._totalDifficulty.delete(blockHash);

    for (const transaction of block.transactions) {
      const transactionHash = bufferToHex(transaction.hash());
      this._transactions.delete(transactionHash);
      this._transactionReceipts.delete(transactionHash);
      this._blocksByTransactions.delete(transactionHash);
    }
  }

  public addTransaction(transaction: TypedTransaction) {
    this._transactions.set(bufferToHex(transaction.hash()), transaction);
  }

  public addTransactionReceipt(receipt: RpcReceiptOutput) {
    this._transactionReceipts.set(receipt.transactionHash, receipt);
  }
  public splitAnyEmptyBlockRangesFor(blockNumber: BN): boolean {
    // if blockNumber lies within one of the ranges listed in
    // this.emptyBlockRanges, then that range needs to be split in two in order
    // to accomodate the accessing of the given block.

    // determine whether any empty block ranges contain the block number.
    const rangeIndex = this.emptyBlockRanges.findIndex(
      (range) => range.first.lte(blockNumber) && range.last.gte(blockNumber)
    );
    if (rangeIndex === -1) {
      return false;
    } else {
      console.log(
        "BlockchainData.splitANyEmptyBlockRangesFor(): the block number lies within the identified empty block range"
      );
      // the block number lies within the identified empty block range

      const oldRange = this.emptyBlockRanges[rangeIndex];

      this.emptyBlockRanges.splice(rangeIndex, 1);

      if (!blockNumber.eq(oldRange.first)) {
        console.log("a");
        this.emptyBlockRanges.push({
          first: oldRange.first,
          last: blockNumber.subn(1),
          intervalInSeconds: oldRange.intervalInSeconds,
        });
      }

      if (!blockNumber.eq(oldRange.last)) {
        console.log("b");
        this.emptyBlockRanges.push({
          first: blockNumber.addn(1),
          last: oldRange.last,
          intervalInSeconds: oldRange.intervalInSeconds,
        });
      }

      return true;
    }
  }
}
