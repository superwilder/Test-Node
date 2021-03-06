import Libp2p from "libp2p";
import fs from "fs";
import path from "path";
import { DBs, LogPaths, PubSubMessage, ZChainMessage } from "../types";
import { decode, encode } from "./encryption";
import { toString as uint8ArrayToString } from "uint8arrays/to-string";
import { fromString } from "uint8arrays/from-string";

import { IPFS as IIPFS } from 'ipfs';
import OrbitDB from "orbit-db";
import FeedStore from "orbit-db-feedstore";
import KeyValueStore from "orbit-db-kvstore";
import chalk from "chalk";
import os from 'os'
import Store from "orbit-db-store";

// maybe we should change this to ~/.zchain-db ?
const ZCHAIN_DEFAULT_STORAGE_DIR = "./zchain-db";

// zchain operations are at the "system" level
const SYSPATH = 'sys';

/**
 * Class to handle data of libp2p libp2p (persisting data through hypercore append only logs)
 * + Store(append) newly discovered peers to logs
 */
export class ZStore {
  protected libp2p: Libp2p;
  protected ipfs: IIPFS;
  orbitdb: OrbitDB;
  private password: string;
  private paths: LogPaths;
  dbs: DBs;
  private feedMap: Map<string, number>

  /**
   * Initializes zchain-db (hypercore append only log)
   * @param libp2p libp2p node
   */
  constructor (ipfs: IIPFS, libp2p: Libp2p, password: string) {
    this.ipfs = ipfs;
    this.libp2p = libp2p;

    // going through "type hacks" (as they'll be initialized later)
    this.paths = {} as any;
    this.dbs = {} as any;
    this.dbs.feeds = {};
    this.feedMap = new Map<string, number>();

    // save password
    if (password.length !== 16) {
      throw new Error("Password must be a string of length 16");
    } else {
      this.password = password;
    }
  }

  async init(): Promise<void> {
    const peerId = await this.ipfs.config.get('Identity.PeerID')
    this.orbitdb = await OrbitDB.createInstance(
      this.ipfs as any,
      {
        directory: path.join(os.homedir(), `/.zchain-db/${peerId}`),
        peerId: peerId as string
      }
    );

    // eg. ./zchain-db/{peerId}/sys/<log>
    this.paths.default = this.libp2p.peerId.toB58String() + "." + SYSPATH;
    this.paths.feeds = this.paths.default + '.feed';
    this.paths.addressBook = this.paths.default + '.addressBook';
    //this.paths.channels = path.join(this.paths.default, 'channels');

    this.dbs.feeds[this.libp2p.peerId.toB58String()] = await this.getFeedsOrbitDB(
      this.paths.feeds
    );
    this.dbs.addressBook = await this.getKeyValueOrbitDB(this.paths.addressBook);
  }

  /**
   * @returns orbitdb database of the node's feed (list of messages posted by node)
   */
  getFeedDB(): FeedStore<unknown> {
    return this.dbs.feeds[this.libp2p.peerId.toB58String()];
  }

  /**
   * Initializes an orbitdb of type "keyValue"
   * @param dbName name of the database
   */
  async getKeyValueOrbitDB(dbName: string): Promise<KeyValueStore<unknown>> {
    const db = await this.orbitdb.keyvalue(dbName);
    await db.load();
    return db;
  }

  /**
   * Initialzes an orbitdb of type "feed" (mutable log with traversible history)
   * @param dbName name of the database
   */
  async getFeedsOrbitDB(dbName: string) {
    const db = await this.orbitdb.feed(dbName);
    await db.load();
    return db;
  }

  async appendZChainMessageToFeed(
    feedStore: FeedStore<unknown>,
    message: string,
    channels: string[]
    ): Promise<void> {
    await feedStore.load(1); // load last block to memory

    // this is a bug (check it)
    let prev = null;
    const lastBlock = feedStore.iterator({ limit: 1, reverse: true }).collect()
      .map((e) => e.payload.value);
    if (lastBlock.length !== 0) {
      const parsed = lastBlock[0] as ZChainMessage;
      prev = parsed.message; // hash of prev message
    }

    // verify you cannot spoof a signature, like i can't just copy it & spam it
    const zChainMessage = {
      prev: prev,
      from: this.libp2p.peerId.toB58String(),
      channel: channels,
      message: await encode(message, this.password),
      // timestamp: Math.round(+new Date() / 1000),
    }

    await feedStore.add(zChainMessage);
  }

  /**
   * Handle publishing of a message
   * @param channel channel accross which message was published
   * @param message libp2p pubsub message
   */
  async handlePublish(message: string, channels: string[]): Promise<void> {
    // const pubsubMsg = {
    //   channelIDs: [channel],
    //   from: this.libp2p.peerId.toB58String(),
    //   data: fromString(message),
    //   seqno: new Uint8Array([0]),
    //   signature: new Uint8Array([0]),
    //   key: new Uint8Array([0]),
    //   receivedFrom: this.libp2p.peerId.toB58String()
    // };

    // only append to my feed a single time (eg. if we're publishing same
    // message accross multiple channels, we only want to append it to feed single time)
    const currTs = Math.round(+new Date() / 10000);
    if (this.feedMap.get(message + currTs.toString()) === undefined) {
      const feedCore = this.dbs.feeds[this.libp2p.peerId.toB58String()];
      await this.appendZChainMessageToFeed(feedCore, message, channels);
      this.feedMap.set(message + currTs.toString(), 1);
    }
  }

  /**
   * Lists last "n" messages published by a node
   */
  async listMessagesOnFeed(peerIdStr: string, n: number): Promise<void> {
    const feedStore = this.dbs.feeds[peerIdStr];
    if (feedStore === undefined) {
      console.error("feed store not found for peer ", peerIdStr);
      return;
    }

    await feedStore.load(n); // load last "n" messages to memory
    const messages = feedStore.iterator({
      limit: n, reverse: true
    }).collect();

    console.log("messages :: ", messages);
    console.log(chalk.cyanBright(`Last ${n} messages published by ${peerIdStr}`));
    for (const m of messages) {
      const msg = m.payload.value as ZChainMessage;
      console.log(`${chalk.green('>')} `, {
        ...msg,
        message: await decode(msg.message, this.password)
      });
    }
  }
}
