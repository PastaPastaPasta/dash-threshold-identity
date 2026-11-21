import { Session } from '../../src/app.mjs';
import { assert } from '../../src/util.mjs';

export const NETWORK = 'testnet';

const testnetOnly = (network, what) => assert(network === NETWORK, `${what} is on ${network}; this hosted build works on testnet only`);

export class TestnetSession extends Session {
  constructor({ relay, ...rest }) {
    super(rest);
    this.relay = relay;
  }

  requireRoom() {
    const data = super.requireRoom();
    data.relay = this.relay;
    return data;
  }

  async proposeCeremony(args) {
    testnetOnly(args.network ?? NETWORK, 'this ceremony');
    return super.proposeCeremony({ ...args, network: NETWORK });
  }

  ceremony(cid) {
    const c = super.ceremony(cid);
    testnetOnly(c.config.network, `ceremony ${c.cid.slice(0, 12)}`);
    return c;
  }

  identity(identityId) {
    const id = super.identity(identityId);
    testnetOnly(id.network, `identity ${id.identityId}`);
    return id;
  }

  findProposal(prefix) {
    const found = super.findProposal(prefix);
    testnetOnly(found.p.body.network, `proposal ${found.p.id.slice(0, 12)}`);
    return found;
  }

  async propose(network, intent, note) {
    testnetOnly(network, 'this proposal');
    return super.propose(network, intent, note);
  }

  async sdk(network) {
    testnetOnly(network, 'the Platform connection');
    return super.sdk(network);
  }

  funding(network) {
    testnetOnly(network, 'the funding address');
    return super.funding(network);
  }

  async assetLock(network, args) {
    testnetOnly(network, 'this asset lock');
    return super.assetLock(network, { ...args, confirmMainnet: false });
  }
}
