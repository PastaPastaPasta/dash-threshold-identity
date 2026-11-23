import { Session } from '../../src/app.mjs';
import { assert, sha256hex } from '../../src/util.mjs';
import { network as networkOf, roomOnNetwork, roomPrefix, roomNetwork } from '../../src/networks.mjs';
import { openRoom } from '../../src/store.mjs';

export class NetworkSession extends Session {
  constructor({ relay, network, mainnetWrites = false, room, ...rest }) {
    super(rest);
    this.relay = relay;
    this.network = networkOf(network).id;
    this.readOnly = this.network === 'mainnet' && !mainnetWrites;
    if (room) this.useRoom(room, relay);
  }

  onNetwork(network, what) {
    assert(network === this.network, `${what} is on ${networkOf(network).label}, but this page is on ${networkOf(this.network).label}; switch networks to use it`);
  }

  writable(what) {
    assert(!this.readOnly, `${what} is turned off on Mainnet in this build; Mainnet is read-only here until it has been reviewed`);
  }

  checkRoom(room) {
    if (!roomOnNetwork(room, this.network)) {
      const other = roomNetwork(room);
      throw new Error(`this group is ${other ? `on ${networkOf(other).label}` : 'from an older Testnet build'}, but this page is on ${networkOf(this.network).label}; switch networks to open it`);
    }
  }

  requireRoom() {
    const data = super.requireRoom();
    this.checkRoom(data.room);
    data.relay = this.relay;
    return data;
  }

  useRoom(room, relay, label) {
    this.checkRoom(room);
    super.useRoom(room, relay, label);
  }

  createRoom({ label, name }) {
    const room = `${roomPrefix(this.network)}_${sha256hex(`dti-room|${this.network}|${this.keys.authPub}|${label}|${new Date().toISOString()}`).slice(0, 32)}`;
    this.data = openRoom(room, { relay: this.relay, label });
    return this.joinRoom({ room, relay: this.relay, name, group: label });
  }

  async proposeCeremony(args) {
    this.writable('Making group keys');
    if (args.network !== undefined) this.onNetwork(args.network, 'this key ceremony');
    return super.proposeCeremony({ ...args, network: this.network });
  }

  async advanceCeremony(cid, options) {
    this.writable('Taking part in a key ceremony');
    return super.advanceCeremony(cid, options);
  }

  ceremony(cid) {
    const c = super.ceremony(cid);
    this.onNetwork(c.config.network, `key ceremony ${c.cid.slice(0, 12)}`);
    return c;
  }

  identity(identityId) {
    const id = super.identity(identityId);
    this.onNetwork(id.network, `identity ${id.identityId}`);
    return id;
  }

  findProposal(prefix) {
    const found = super.findProposal(prefix);
    this.onNetwork(found.p.body.network, `proposal ${found.p.id.slice(0, 12)}`);
    return found;
  }

  async prepare(kind, args) {
    this.writable('Proposing');
    return super.prepare(kind, args);
  }

  async propose(network, intent, note) {
    this.writable('Proposing');
    this.onNetwork(network, 'this proposal');
    return super.propose(network, intent, note);
  }

  async approve(proposalId, options) {
    this.writable('Signing');
    return super.approve(proposalId, options);
  }

  async reject(proposalId, reason) {
    this.writable('Rejecting');
    return super.reject(proposalId, reason);
  }

  async execute(proposalId) {
    this.writable('Broadcasting');
    return super.execute(proposalId);
  }

  async topUp(args) {
    this.writable('Topping up');
    return super.topUp(args);
  }

  async sdk(network) {
    this.onNetwork(network, 'the Platform connection');
    return super.sdk(network);
  }

  funding(network) {
    this.onNetwork(network, 'the funding address');
    return super.funding(network);
  }

  async assetLock(network, args) {
    this.writable('Locking funds');
    this.onNetwork(network, 'this asset lock');
    return super.assetLock(network, args);
  }

  async claimFunding(cid) {
    this.writable('Funding');
    return super.claimFunding(cid);
  }

  async proposeIdentityCreate(args) {
    this.writable('Creating an identity');
    return super.proposeIdentityCreate(args);
  }
}
