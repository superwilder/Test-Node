import FeedStore from "orbit-db-feedstore";
import { ZCHAIN, ZStore, assertValidzId, types, decode } from "zchain-core";
import { DB_ADDRESS_PROTOCOL, password } from "./constants";
import { pipe } from 'it-pipe';
import chalk from "chalk";
import { MeowDBs } from "../types";
import { fromString } from "uint8arrays/from-string";
import { toString as uint8ArrayToString } from "uint8arrays/to-string";

function isValidzId(zId: string): Boolean {
  let isValid = true;
  try {
    assertValidzId(zId);
  } catch (error) {
    isValid = false;
  }

  return isValid;
}

// meow operations are at the "application" level
const APP_PATH = 'apps';

/**
 * Class to storage at "meow" level (application level)
 */
export class MStore extends ZStore {
  // key value storage of nodes i follow
  zChain: ZCHAIN;
  protected meowDbs: MeowDBs;

  /**
   * Initializes MStore
   * @param libp2p libp2p node
   */
  constructor (zChain: ZCHAIN) {
    super(zChain.ipfs, zChain.node, password);

    // todo: check why we need this?
    this.dbs = zChain.zStore.dbs

    this.zChain = zChain;
    this.orbitdb = zChain.zStore.orbitdb;
    this.meowDbs = {} as any;
    this.meowDbs.followingZIds = {} as any;
    this.meowDbs.followingTopics = {} as any;
    this.meowDbs.topics = {} as any;
  }

  peerID() { return this.libp2p.peerId.toB58String(); }

  /**
   * Determines {peerId, name, display string} for given peerId/name
   */
  private getNameAndPeerID(peerIdOrName: string): [string, string | undefined, string] {
    let peerId: string, name: string | undefined, str: string;
    if (isValidzId(peerIdOrName)) {
      peerId = peerIdOrName;
      name = this.dbs.addressBook.get(peerId) as string | undefined;
      str = name !== undefined ? `${peerId} (${name})` : `${peerId}`
    } else {
      name = peerIdOrName;

      // if you get a name, peerID must be defined
      if (this.dbs.addressBook.get(name) === undefined) {
        throw new Error(chalk.red(`No peer id found for name ${name}`));
      } else {
        peerId = this.dbs.addressBook.get(name) as string;
        str = `${peerId} (${name})`;
      }
    }

    return [peerId, name, str];
  }

  private async _subscribeToFeed(peerId: string) {
    await this.ipfs.pubsub.subscribe(`${peerId}.sys.feed`, async (msg: types.PubSubMessage) => {
      const orbitDBAddress = uint8ArrayToString(msg.data);
      console.log(`Received from ${msg.from}: ${orbitDBAddress}`);

      // just a sanity check, it should be defined.
      if (this.meowDbs.followingZIds) {
        this.meowDbs.followingZIds = await this.getKeyValueOrbitDB(
          this.peerID() + "." + APP_PATH + '.followers'
        );
      }

      if (this.meowDbs.followingZIds.get(msg.from) === 1 || this.meowDbs.followingZIds.get(msg.from) === undefined) {
        await this.meowDbs.followingZIds.put(msg.from, uint8ArrayToString(msg.data));
        this.dbs.feeds[msg.from] = await this.orbitdb.open(orbitDBAddress) as FeedStore<unknown>;
        this.listenForReplicatedEvent(this.dbs.feeds[msg.from]);
      }
    });
  }

  async init(): Promise<void> {
    const basePath = this.peerID() + "." + APP_PATH;
    this.meowDbs.followingZIds = await this.getKeyValueOrbitDB(
      basePath + '.followers'
    );
    this.meowDbs.followingTopics = await this.getKeyValueOrbitDB(
      basePath + '.topics'
    );

    // during initialization, load the remote databases
    // (if we're following that peer and we have the remote address of that peer's orbitdb)
    const followerList = this.meowDbs.followingZIds.all;
    for (const key in followerList) {
      const feed = this.dbs.feeds[key];
      const remoteAddress = this.meowDbs.followingZIds.get(key);
      if (!feed && typeof remoteAddress === "string") {
        this.dbs.feeds[key] = await this.orbitdb.open(remoteAddress) as FeedStore<unknown>;
        this.listenForReplicatedEvent(this.dbs.feeds[key]);
      }
    }

    // similarly load db for each "topic" (#hashtag)
    const topicsList = this.meowDbs.followingTopics.all;
    for (const key in topicsList) {
      const topicDB = this.meowDbs.topics[key];
      const remoteAddress = this.meowDbs.followingTopics.get(key);
      if (!topicDB && typeof remoteAddress === "string") {
        this.meowDbs.topics[key] = await this.orbitdb.open(remoteAddress) as FeedStore<unknown>;
        this.listenForReplicatedEvent(this.meowDbs.topics[key]);
      }
    }

    // a) broadcast your "own" feed database address on the topic
    setInterval(async () => {
      const feedDB = this.getFeedDB();
      await this.ipfs.pubsub.publish(
        `${this.peerID()}.sys.feed`,
        fromString(feedDB.address.toString())
      );
    }, 5 * 1000);

    // subscribe & listen to the events from peers we're following, & they broadcast their feed address
    for (const key in followerList) {
      const feed = this.dbs.feeds[key];

      // we're following this guy, but we don't have the addr yet
      if (this.meowDbs.followingZIds.get(key) === 1) {
        await this._subscribeToFeed(key);
      }

      // now open the databases as per usual
      const remoteAddress = this.meowDbs.followingZIds.get(key);
      if (!feed && typeof remoteAddress === "string") {
        this.dbs.feeds[key] = await this.orbitdb.open(remoteAddress) as FeedStore<unknown>;
        this.listenForReplicatedEvent(this.dbs.feeds[key]);
      }
    }
  }

  // log replication ("sync" events accross all dbs)
  listenForReplicatedEvent(feed: FeedStore<unknown>): void {
    if (feed) {
      feed.events.on('replicated', (address) => {
        console.log('\n* ' + chalk.green(`Successfully synced db: ${address}`) + ' *\n');
      })
    }
  }

  // listen to db address on new connections
  async handleIncomingOrbitDbAddress (zChain: ZCHAIN): Promise<void> {
    let self = this;

    zChain.peerDiscovery.handleProtocol(DB_ADDRESS_PROTOCOL, async ({ stream, connection }) => {
      pipe(
        stream.source,
        async function (source: any) {
          for await (const msg of source) {
            // if i follow this connection, and feed is not defined yet, load(replicate) it's db
            const address = String(msg).toString().replace('\n', '');

            // i don't think this is a good approach
            self.meowDbs.followingZIds = await self.getKeyValueOrbitDB(
              self.peerID() + "." + APP_PATH + '.followers'
            );

            if (
              address.includes(`/orbitdb/`)
              && self.meowDbs.followingZIds.get(connection.remotePeer.toB58String()) !== undefined
            ) {
              //let feed = self.dbs.feeds[connection.remotePeer.toB58String()];

              // save db address of the node we're follwing, in our "followers" keyValue store
              self.meowDbs.followingZIds.put(connection.remotePeer.toB58String(), address);

              // load the db if not loaded yet
              // NOTE: commenting because we don't need to open a db during daemon run.
              // we'll open it during load()
              // if (feed === undefined) {
              //   feed = await self.orbitdb.open(address) as FeedStore<unknown>;
              //   self.dbs.feeds[connection.remotePeer.toB58String()] = feed;
              //   self.listenForReplicatedEvent(feed);
              // }
            }
          }
        }
      )
    });
  }

  // append to the Followers database (keyvalue) store for the
  // peerId you follow
  async followZId(peerIdOrName: string): Promise<void> {
    const [peerId, _, displayStr] = this.getNameAndPeerID(peerIdOrName);

    const data = this.meowDbs.followingZIds.get(peerId);
    if (data === undefined) {
      await this.meowDbs.followingZIds.put(peerId, 1);
      await this._subscribeToFeed(peerId);
      console.info(chalk.green(`Great! You're now following ${displayStr}`));
    } else {
      console.info(chalk.yellow(`Already following ${displayStr}`));
    }
  }

  async unfollowZId(peerIdOrName: string): Promise<void> {
    const [peerId, _, displayStr] = this.getNameAndPeerID(peerIdOrName);

    const data = this.meowDbs.followingZIds.get(peerId);
    if (data !== undefined) {
      await this.meowDbs.followingZIds.del(peerId);
      console.info(chalk.green(`You've successfully unfollowed ${displayStr}`));
    }

    const feed = this.dbs.feeds[peerId];
    if (feed && peerId !== this.peerID()) {
      await feed.drop(); // drop the db
      this.dbs.feeds[peerId] = undefined;
    }
  }

  async displayFeed(peerIdOrName: string, n: number): Promise<void> {
    const [peerId, _, displayStr] = this.getNameAndPeerID(peerIdOrName);

    if (peerId !== this.peerID() && this.meowDbs.followingZIds.get(peerId) === undefined) {
      console.error(
        chalk.red(`Cannot fetch feed (Invalid request): You're not following ${displayStr}`)
      );
      return;
    }

    const feed = this.dbs.feeds[peerId];
    if (feed === undefined) {
      console.error(
        chalk.red(`Error while loading feed for zId ${displayStr}: not found. The node is possibly offline and feeds are not synced yet.`)
      );
      return;
    }

    await this.listMessagesOnFeed(peerId, n);
  }

  // list peers followed by "this" node
  listFollowedPeers() {
    const all = this.meowDbs.followingZIds.all;
    if (Object.entries(all).length === 0) {
      console.log(chalk.yellow(`Not following any peer`));
      return;
    }

    console.log(`\n${this.peerID()} is following peers:`);
    for (const key in all) {
      const [_, __, displayStr] = this.getNameAndPeerID(key);
      console.log(`${chalk.green('>')} ${displayStr}`);
    }
  }

  listFollowedTopics() {
    const all = this.meowDbs.followingTopics.all;
    console.log(`\n${this.peerID()} is following topics:`);
    for (const key in all) {
      console.log(`${chalk.green('>')} ${key}`);
    }
  }

  /**
   * Get public orbitdb address from a topic
   * @param topic topic to extract db address of
   */
  private async getTopicPublicDBAddress(topic: string): Promise<string> {
    if (topic[0] !== `#`) { topic = '#' + topic; }

    const options = {
      // Give write access to ourselves
      accessController: {
        write: ['*']
      },
      meta: { topic: topic } // this is what makes the db for each topic "unique" from one another
    }
    const address = await this.orbitdb.determineAddress(
      APP_PATH + `.${topic}.feed`, 'feed', options
    );
    return address.toString();
  }

  /**
   * Follow a topic (#hashtag). Save public orbitdb address of the topic
   * to the "followingTopics" database
   * @param topic topic to follow
   */
  async followTopic(topic: string) {
    if (topic[0] !== `#`) { topic = '#' + topic; }

    const data = this.meowDbs.followingTopics.get(topic);
    if (data === undefined) {
      // save {"topic": "topic-db-address"} to db
      const address = await this.getTopicPublicDBAddress(topic);
      await this.meowDbs.followingTopics.put(topic, address);

      // also initialize the database in our local map
      this.meowDbs.topics[topic] = await this.orbitdb.open(address) as FeedStore<unknown>;

      console.info(chalk.green(`Great! You're now following topic ${topic}`));
    } else {
      console.info(chalk.yellow(`Already following topic ${topic}`));
    }
  }

  /**
   * Unfollow a topic (#hashtag). Remove entry from database, and drop the topic
   * database, if present.
   * @param topic topic to unfollow
   */
  async unFollowTopic(topic: string) {
    if (topic[0] !== `#`) { topic = '#' + topic; }

    const data = this.meowDbs.followingTopics.get(topic);
    if (data !== undefined) {
      await this.meowDbs.followingTopics.del(topic);
      console.info(chalk.green(`You've successfully unfollowed ${topic}`));
    }

    const topicDb = this.meowDbs.topics[topic];
    if (topicDb) {
      await topicDb.drop(); // drop the db
      this.meowDbs.topics[topic] = undefined;
    }
  }

  /**
   * Publish a message on a topic. Note: it doesn't matter if "this" node is following
   * this topic or not, we write to the orbitdb on the publishing side of pubsub msg.
   * @param topic topic on which to publish message on
   */
  async publishMessageOnTopic(topic: string, message: string): Promise<void> {
    if (topic[0] !== `#`) { topic = '#' + topic; }

    let db: FeedStore<unknown>;
    let dropDB = false;
    if (this.meowDbs.topics[topic]) {
      db = this.meowDbs.topics[topic];
    } else {
      const address = await this.getTopicPublicDBAddress(topic);
      db = await this.orbitdb.open(address) as FeedStore<unknown>;
      dropDB = true; // since we're not following this topic, we should drop this db, after publish
    }

    await this.appendZChainMessageToFeed(db, topic, message);

    // TODO: think about it more (dropping a db if not following -- the problem is if no
    // other node is online, and we publish & drop the db, the "appended" data us actually LOST)
    //if (dropDB === true) { await db.drop(); }
  }

  /**
   * Lists messages published on a topic.
   * @param topic topic of which to display feed of
   * @param n number of messages (in reverse order) to list
   * @returns
   */
  async displayTopicFeed(topic: string, n: number): Promise<void> {
    if (topic[0] !== `#`) { topic = '#' + topic; }

    if (this.meowDbs.followingTopics.get(topic) === undefined) {
      console.error(
        chalk.red(`Cannot fetch feed (Invalid request): You're not following ${topic}`)
      );
      return;
    }

    const topicDB = this.meowDbs.topics[topic];
    if (topicDB === undefined) {
      console.error(
        chalk.red(`Error while loading feed for ${topic}: NOT FOUND.`)
      );
      return;
    }

    await topicDB.load(n); // load last "n" messages to memory
    const messages = topicDB.iterator({
      limit: n, reverse: true
    }).collect();

    console.log(chalk.cyanBright(`Last ${n} messages published on ${topic}`));
    for (const m of messages) {
      const msg = m.payload.value as types.ZChainMessage;
      console.log(`${chalk.green('>')} `, {
        ...msg,
        message: await decode(msg.message, password)
      });
    }
  }

  /**
   * Lists all db's with address & no. of entries
   */
  async listDBs(): Promise<void> {
    const dbs = {};
    const topicsList = this.meowDbs.followingTopics.all;
    const followerList = this.meowDbs.followingZIds.all;
    const addressBook = this.dbs.addressBook.all;

    dbs["followingZIds"] = {
      "address": this.meowDbs.followingZIds.address.toString(),
      "entries": Object.entries(followerList).length
    }

    dbs["followingTopics"] = {
      "address": this.meowDbs.followingTopics.address.toString(),
      "entries": Object.entries(topicsList).length
    }

    dbs["addressBook"] = {
      "address": this.dbs.addressBook.address.toString(),
      "entries": Object.entries(addressBook).length
    }

    dbs["Peer feeds"] = {};
    for (const key in followerList) {
      const feed = this.dbs.feeds[key];
      const remoteAddress = this.meowDbs.followingZIds.get(key);
      if (feed && typeof remoteAddress === "string") {
        await feed.load();
        dbs["Peer feeds"][key] = {
          "address": remoteAddress,
          "entries": feed.iterator({ limit: -1 }).collect().length
        }
      }
    }

    dbs["Topic feeds"] = {};
    for (const key in topicsList) {
      const topicDB = this.meowDbs.topics[key];
      const remoteAddress = this.meowDbs.followingTopics.get(key);
      if (topicDB && typeof remoteAddress === "string") {
        await topicDB.load();
        dbs["Topic feeds"][key] = {
          "address": remoteAddress,
          "entries": topicDB.iterator({ limit: -1 }).collect().length
        }
      }
    }

    console.log(dbs);
  }

  /**
   * Sets a name of the peerId in the local address book
   * @param peerId peerID
   * @param name name to set
   */
  async setNameInAddressBook(peerId: string, name: string): Promise<void> {
    assertValidzId(peerId);

    let db = this.dbs.addressBook;
    if (!db) {
      console.log("Internal error: address book db not defined in ctx");
      return;
    }

    const peerName = await db.get(peerId);
    const peerID = await db.get(name);
    if (peerName !== undefined) {
      console.warn(chalk.yellowBright(`Name for peer ${peerId} has already been set to ${peerName}`));
    } else if (peerID !== undefined) {
      console.warn(chalk.yellowBright(`A peerId has already been set against this name (${name}) to ${peerID}`));
    } else {
      db.set(peerId, name);
      db.set(name, peerId);
      console.info(chalk.green(`Successfully set name for ${peerId} to ${name} in local address book`));
    }
  }
}

