import { seedFromMnemonic, participantKeys, kdf } from './derive.mjs';
import { reduce } from './state.mjs';
import * as participant from './participant.mjs';
import { DEFAULT_KEYS, participantIndex } from './ceremony.mjs';
import { openRoom, loadRoom, addMessages, journal } from './store.mjs';
import { envelopeId } from './envelope.mjs';
import { sync as relaySync, push } from './relay/client.mjs';
import { connect, retry, errorText, sdkModule, protocolVersionOf } from './platform/sdk.mjs';
import { makeProposalBody, reviewProposal, signedTransition } from './proposals.mjs';
import { describeIntent } from './platform/transitions.mjs';
import * as core from './platform/core.mjs';
import { sha256hex, hex, assert, toPlain } from './util.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SNAPSHOT = /ExecutionNotProved|affected.?state/i;

async function confirmOnChain(sdk, intent, derived, attempts = 10) {
  for (let i = 0; i < attempts; i++) {
    try {
      switch (intent.type) {
        case 'identity-create':
          if (await sdk.identities.fetch(derived.identityId)) return true;
          break;
        case 'contract-update':
        case 'document': {
          const n = await sdk.identities.contractNonce(intent.ownerId, intent.contractId);
          if (n !== undefined && (BigInt(n) & 0xffffffffffn) >= BigInt(intent.identityContractNonce)) return true;
          break;
        }
        default: {
          const n = await sdk.identities.nonce(intent.identityId ?? intent.ownerId);
          if (n !== undefined && (BigInt(n) & 0xffffffffffn) >= BigInt(intent.nonce ?? intent.identityNonce)) return true;
        }
      }
    } catch {
      /* retry */
    }
    await sleep(3000);
  }
  return false;
}

export class Session {
  constructor({ mnemonic, passphrase = '', room, relay, log = () => {} }) {
    this.seed = seedFromMnemonic(mnemonic, passphrase);
    this.keys = participantKeys(this.seed);
    this.log = log;
    this.sdks = {};
    if (room) this.data = loadRoom(room) ?? openRoom(room, { relay });
    if (this.data && relay) this.data.relay = relay;
  }

  whoami() {
    return { authPub: this.keys.authPub, transportPub: this.keys.transportPub, fingerprint: this.keys.fingerprint };
  }

  requireRoom() {
    assert(this.data, 'no room selected (use --room)');
    return this.data;
  }

  state() {
    return reduce(this.requireRoom().messages, { room: this.data.room });
  }

  async sync() {
    const data = this.requireRoom();
    if (!data.relay) return { pulled: 0, pushed: 0 };
    return relaySync(data);
  }

  async post(envelopes) {
    const data = this.requireRoom();
    addMessages(data, envelopes);
    if (data.relay && envelopes.length) await push(data, envelopes);
    return envelopes;
  }

  async sdk(network) {
    this.sdks[network] ??= connect(network);
    return this.sdks[network];
  }

  createRoom({ label, relay, name }) {
    const room = sha256hex(`dti-room|${this.keys.authPub}|${label}|${new Date().toISOString()}`).slice(0, 32);
    this.data = openRoom(room, { relay, label });
    return this.joinRoom({ room, relay, name });
  }

  async joinRoom({ room, relay, name }) {
    this.data = loadRoom(room) ?? openRoom(room, { relay });
    if (relay) this.data.relay = relay;
    await this.sync();
    const mine = this.state().hellos[this.keys.authPub];
    if (!mine || mine.name !== name) await this.post([participant.hello(this.keys, room, name)]);
    return { room, relay: this.data.relay, ...this.whoami() };
  }

  status() {
    const s = this.state();
    return {
      room: this.data.room,
      relay: this.data.relay,
      me: this.whoami(),
      members: Object.values(s.hellos).map((h) => ({ name: h.name, authPub: h.authPub, fingerprint: h.fingerprint, me: h.authPub === this.keys.authPub })),
      ceremonies: Object.values(s.ceremonies).map((c) => ({
        cid: c.cid, label: c.config.label, network: c.config.network, threshold: c.config.threshold, status: c.status,
        participants: c.config.participants.map((p) => ({ index: p.index, name: p.name, fingerprint: s.hellos[p.authPub]?.fingerprint, accepted: p.index in c.accepts, committed: p.index in c.commits, revealed: p.index in c.reveals, completed: p.index in c.completes })),
        myIndex: participantIndex(c.config, this.keys.authPub),
        keys: c.result ? Object.fromEntries(Object.entries(c.result.keys).map(([slot, k]) => [slot, { keyId: k.keyId, purpose: k.purpose, securityLevel: k.securityLevel, groupPublicKey: k.groupPublicKey }])) : null,
        problems: [...c.problems, ...c.complaints, ...c.equivocations],
      })),
      identities: this.identities(s),
      proposals: Object.values(s.proposals).sort((a, b) => a.at.localeCompare(b.at)).map((p) => this.proposalSummary(s, p)),
      invalidMessages: s.invalid.length,
      problems: s.problems,
    };
  }

  proposalSummary(s, p) {
    return {
      id: p.id, at: p.at, status: p.status, error: p.error, type: p.body.intent?.type, network: p.body.network,
      proposer: s.hellos[p.from]?.name ?? p.from.slice(0, 12), summary: describeIntent(p.body.intent), note: p.body.note,
      requirements: p.requirements.map((r) => ({ key: r.key, slot: r.slot, threshold: r.threshold, approvals: Object.keys(r.shares).map(Number), invalid: r.invalidShares })),
      approvedByMe: this.keys.authPub in p.approvals, rejections: Object.entries(p.rejections).map(([k, v]) => ({ by: s.hellos[k]?.name ?? k.slice(0, 12), reason: v.reason })),
      broadcasts: p.broadcasts.map((b) => ({ at: b.at, by: s.hellos[b.from]?.name, ...b.result })), derived: p.body.derived,
    };
  }

  identities(s = this.state()) {
    const out = {};
    const executed = Object.values(s.proposals).filter((p) => p.status === 'executed').sort((a, b) => a.at.localeCompare(b.at));
    for (const p of executed) {
      const i = p.body.intent;
      if (i.type === 'identity-create') {
        out[p.body.derived.identityId] = { identityId: p.body.derived.identityId, network: p.body.network, keys: Object.fromEntries(i.keys.map((k) => [k.keyId, { ...k, disabled: false }])) };
      } else if (i.type === 'identity-update' && out[i.identityId]) {
        for (const k of i.addKeys) out[i.identityId].keys[k.keyId] = { ...k, disabled: false };
        for (const id of i.disableKeyIds) if (out[i.identityId].keys[id]) out[i.identityId].keys[id].disabled = true;
      }
    }
    return Object.values(out);
  }

  identity(identityId) {
    const all = this.identities();
    if (!identityId) {
      assert(all.length === 1, all.length ? 'several identities in this room; pass --identity' : 'no identity has been created in this room yet');
      return all[0];
    }
    const found = all.find((x) => x.identityId === identityId);
    assert(found, `identity ${identityId} was not created through this room`);
    return found;
  }

  signerFor(identity, slotOrKeyId) {
    const keys = Object.values(identity.keys).filter((k) => !k.disabled);
    const k = keys.find((x) => String(x.keyId) === String(slotOrKeyId)) ?? keys.filter((x) => x.slot === slotOrKeyId).at(-1);
    assert(k, `identity ${identity.identityId} has no enabled key "${slotOrKeyId}"`);
    return { keyId: k.keyId, cid: k.cid, slot: k.slot };
  }

  ceremony(cid) {
    const s = this.state();
    const list = Object.values(s.ceremonies);
    const c = cid ? s.ceremonies[cid] ?? list.find((x) => x.cid.startsWith(cid)) : list.at(-1);
    assert(c, 'no such ceremony');
    return c;
  }

  async proposeCeremony({ network, threshold, label, members, keys = DEFAULT_KEYS }) {
    const s = this.state();
    const roster = members?.length ? members : Object.keys(s.hellos);
    const { cid, envelope } = participant.proposeCeremony(this.keys, this.data.room, s, { network, label, threshold, members: roster, keys });
    await this.post([envelope]);
    return { cid };
  }

  async advanceCeremony(cid, { confirm = async () => false } = {}) {
    await this.sync();
    const c = this.ceremony(cid);
    const step = participant.nextCeremonyStep(this.seed, this.keys, this.data.room, this.state(), c.cid);
    if (step.needsConfirmation && !(await confirm(c))) return { cid: c.cid, action: 'declined' };
    await this.post(step.envelopes);
    return { cid: c.cid, action: step.action, status: this.ceremony(c.cid).status };
  }

  async runCeremony(cid, { confirm, pollMs = 3000, timeoutMs = 30 * 60 * 1000 } = {}) {
    const start = Date.now();
    let last = null;
    while (Date.now() - start < timeoutMs) {
      const r = await this.advanceCeremony(cid, { confirm });
      if (r.action !== last) this.log(`ceremony ${r.cid.slice(0, 12)}: ${r.action} (${r.status ?? ''})`);
      last = r.action;
      if (['done', 'failed', 'declined'].includes(r.action) || r.status === 'failed') return { ...r, ceremony: this.ceremony(r.cid).result };
      if (r.action.startsWith('wait')) await sleep(pollMs);
    }
    throw new Error('ceremony timed out');
  }

  funding(network) {
    const account = core.fundingAccount(this.seed, network);
    return { address: account.address, path: account.path };
  }

  async fundingBalance(network) {
    const { address } = this.funding(network);
    const list = await core.utxos(network, address);
    return { address, duffs: list.reduce((a, u) => a + u.satoshis, 0), utxos: list.length };
  }

  async assetLock(network, { duffs, kind = 'registration', index }) {
    const j = journal(`asset-locks-${network}-${this.keys.authPub.slice(0, 16)}`);
    const all = j.get();
    const key = `${kind}/${index}`;
    let rec = all[key];
    const credit = kind === 'registration' ? core.registrationKey(this.seed, network, index) : core.topUpKey(this.seed, network, index);
    if (!rec) {
      const account = core.fundingAccount(this.seed, network);
      const built = core.buildAssetLock({ network, funding: account, utxoList: await core.utxos(network, account.address), creditAddress: credit.address, duffs });
      rec = { kind, index, duffs, txid: built.txid, vout: 0, state: 'built', creditAddress: credit.address };
      all[key] = rec;
      j.set(all);
      await core.broadcastRaw(network, built.rawtx);
      rec.state = 'broadcast';
      j.set(all);
      this.log(`asset lock ${built.txid} broadcast (${duffs} duffs, fee ${built.fee})`);
    }
    if (rec.state !== 'chainlocked') {
      const sdk = await this.sdk(network);
      const lock = await core.waitForChainLock(network, sdk, rec.txid, { onWait: (m) => this.log(m) });
      rec.coreChainLockedHeight = lock.coreChainLockedHeight;
      rec.height = lock.height;
      rec.state = 'chainlocked';
      j.set(all);
    }
    return rec;
  }

  nextAssetLockIndex(network, kind) {
    const all = journal(`asset-locks-${network}-${this.keys.authPub.slice(0, 16)}`).get();
    const used = Object.values(all).filter((r) => r.kind === kind).map((r) => r.index);
    return used.length ? Math.max(...used) + 1 : 0;
  }

  async proposeIdentityCreate({ cid, duffs, index }) {
    const c = this.ceremony(cid);
    assert(c.status === 'complete', `ceremony is ${c.status}`);
    const network = c.config.network;
    const keyIndex = index ?? this.nextAssetLockIndex(network, 'registration');
    const lock = await this.assetLock(network, { duffs, kind: 'registration', index: keyIndex });
    const intent = {
      type: 'identity-create',
      assetLockProof: { coreChainLockedHeight: lock.coreChainLockedHeight, txid: lock.txid, vout: 0, keyIndex, funder: this.keys.authPub },
      keys: Object.values(c.result.keys).map((k) => ({ cid: c.cid, slot: k.slot, keyId: k.keyId, purpose: k.purpose, securityLevel: k.securityLevel, publicKey: k.groupPublicKey })),
      userFeeIncrease: 0,
    };
    return this.propose(network, intent, `fund ${duffs} duffs`);
  }

  async propose(network, intent, note = '') {
    const body = await makeProposalBody(network, intent, note);
    const [envelope] = await this.post([participant.propose(this.keys, this.data.room, body)]);
    const id = envelopeId(envelope);
    return { id, summary: describeIntent(intent), derived: body.derived };
  }

  async chainContext(network, identityId) {
    const sdk = await this.sdk(network);
    const nonce = (await retry(() => sdk.identities.nonce(identityId))) ?? 0n;
    const identity = await retry(() => sdk.identities.fetch(identityId));
    assert(identity, `identity ${identityId} not found`);
    const m = await sdkModule();
    return { sdk, nonce, revision: BigInt(identity.revision), protocolVersion: protocolVersionOf(m.PlatformVersion.latest()) };
  }

  async prepare(kind, args) {
    await this.sync();
    const id = this.identity(args.identityId);
    const network = id.network;
    const ctx = await this.chainContext(network, id.identityId);
    const signer = args.signer !== undefined ? this.signerFor(id, args.signer) : null;
    const base = { userFeeIncrease: args.userFeeIncrease ?? 0 };
    let intent;
    switch (kind) {
      case 'contract-create':
        intent = { type: kind, ...base, ownerId: id.identityId, identityNonce: String(ctx.nonce + 1n), protocolVersion: ctx.protocolVersion, contract: args.contract, signer };
        break;
      case 'contract-update': {
        const contract = await retry(() => ctx.sdk.contracts.fetch(args.contractId));
        assert(contract, `contract ${args.contractId} not found`);
        const cnonce = (await retry(() => ctx.sdk.identities.contractNonce(id.identityId, args.contractId))) ?? 0n;
        intent = { type: kind, ...base, ownerId: id.identityId, contractId: args.contractId, identityContractNonce: String(cnonce + 1n), version: Number(contract.version) + 1, protocolVersion: ctx.protocolVersion, contract: args.contract, signer };
        break;
      }
      case 'document': {
        const cnonce = (await retry(() => ctx.sdk.identities.contractNonce(id.identityId, args.contractId))) ?? 0n;
        const document = { action: args.action, documentType: args.documentType, properties: args.properties };
        if (args.action === 'create') document.entropy = hex(kdf(this.seed, 'document/entropy', [args.contractId, String(cnonce + 1n), args.documentType, JSON.stringify(args.properties ?? {})]));
        else {
          const current = await retry(() => ctx.sdk.documents.get(args.contractId, args.documentType, args.documentId));
          assert(current, `document ${args.documentId} not found`);
          document.id = args.documentId;
          document.revision = String(current.revision);
        }
        intent = { type: kind, ...base, ownerId: id.identityId, contractId: args.contractId, identityContractNonce: String(cnonce + 1n), document, signer };
        break;
      }
      case 'credit-transfer':
        intent = { type: kind, ...base, identityId: id.identityId, recipientId: args.recipientId, amount: String(args.amount), nonce: String(ctx.nonce + 1n), signer };
        break;
      case 'credit-withdrawal':
        intent = { type: kind, ...base, identityId: id.identityId, amount: String(args.amount), coreFeePerByte: args.coreFeePerByte ?? 1, pooling: 'Never', outputAddress: args.toAddress, outputPubKeyHash: core.addressToPubKeyHash(network, args.toAddress), nonce: String(ctx.nonce + 1n), signer };
        break;
      case 'identity-update': {
        const addKeys = (args.addKeys ?? []).map(({ cid, slot }) => {
          const c = this.ceremony(cid);
          assert(c.status === 'complete' && c.result.keys[slot], `no completed key ${slot} in ceremony ${cid}`);
          const k = c.result.keys[slot];
          return { cid: c.cid, slot, keyId: k.keyId, purpose: k.purpose, securityLevel: k.securityLevel, publicKey: k.groupPublicKey };
        });
        intent = { type: kind, ...base, identityId: id.identityId, revision: String(ctx.revision + 1n), nonce: String(ctx.nonce + 1n), addKeys, disableKeyIds: args.disableKeyIds ?? [], signer: this.signerFor(id, args.signer ?? 'master') };
        break;
      }
      default:
        throw new Error(`unknown proposal kind ${kind}`);
    }
    return this.propose(network, intent, args.note ?? '');
  }

  findProposal(prefix) {
    const s = this.state();
    const p = s.proposals[prefix] ?? Object.values(s.proposals).find((x) => x.id.startsWith(prefix));
    assert(p, `no proposal ${prefix}`);
    return { s, p };
  }

  async review(proposalId, { online = true } = {}) {
    await this.sync();
    const { s, p } = this.findProposal(proposalId);
    const sdk = online ? await this.sdk(p.body.network).catch(() => null) : null;
    const report = await reviewProposal(s, p.id, { sdk });
    return { id: p.id, proposer: s.hellos[p.from]?.name, ...report, proposal: this.proposalSummary(s, p), intent: p.body.intent };
  }

  async approve(proposalId, { confirm = async () => true, online = true } = {}) {
    const report = await this.review(proposalId, { online });
    assert(report.ok, `refusing to approve: ${report.problems.join('; ')}`);
    assert(!report.proposal.approvedByMe, 'you already approved this proposal');
    if (!(await confirm(report))) return { id: report.id, approved: false };
    await this.post([participant.approve(this.seed, this.keys, this.data.room, this.state(), report.id)]);
    return { id: report.id, approved: true, status: this.findProposal(report.id).p.status };
  }

  async reject(proposalId, reason) {
    const { p } = this.findProposal(proposalId);
    await this.post([participant.reject(this.keys, this.data.room, p.id, reason)]);
    return { id: p.id, rejected: true };
  }

  async execute(proposalId) {
    await this.sync();
    const { s, p } = this.findProposal(proposalId);
    assert(p.status === 'ready', `proposal is ${p.status}`);
    const signatures = participant.combine(s, p.id);
    const built = await signedTransition(s, p.id, signatures);
    const intent = p.body.intent;
    if (intent.type === 'identity-create') {
      assert(intent.assetLockProof.funder === this.keys.authPub, 'only the funder who built the asset lock can finalize identity creation');
      await core.signWithAssetLockKey(built.st, core.registrationKey(this.seed, p.body.network, intent.assetLockProof.keyIndex));
    }
    const sdk = await this.sdk(p.body.network);
    const stHash = built.st.hash(false);
    let result;
    try {
      await sdk.stateTransitions.broadcastAndWait(built.st);
      result = { ok: true, stHash };
    } catch (e) {
      const text = errorText(e);
      result = SNAPSHOT.test(text) ? { ok: true, stHash, note: 'accepted; result returned as an affected-state snapshot' } : { ok: false, stHash, error: text };
    }
    if (result.ok) {
      result.confirmed = await confirmOnChain(sdk, intent, p.body.derived);
      if (!result.confirmed) Object.assign(result, { ok: false, error: 'broadcast returned, but a proved read does not show the change' });
    }
    result.signers = Object.fromEntries(Object.entries(signatures).map(([k, v]) => [k, v.signers]));
    await this.post([participant.recordBroadcast(this.keys, this.data.room, p.id, result)]);
    return { id: p.id, ...result, derived: p.body.derived };
  }

  async topUp({ identityId, duffs, index }) {
    await this.sync();
    const id = this.identity(identityId);
    const keyIndex = index ?? this.nextAssetLockIndex(id.network, 'topup');
    const lock = await this.assetLock(id.network, { duffs, kind: 'topup', index: keyIndex });
    const st = await core.topUpTransition({ network: id.network, seed: this.seed, index: keyIndex, identityId: id.identityId, proof: { coreChainLockedHeight: lock.coreChainLockedHeight, txid: lock.txid, vout: 0 } });
    const sdk = await this.sdk(id.network);
    const before = (await retry(() => sdk.identities.balance(id.identityId))) ?? 0n;
    try {
      await sdk.stateTransitions.broadcastAndWait(st);
    } catch (e) {
      if (!SNAPSHOT.test(errorText(e))) throw e;
    }
    for (let i = 0; i < 10; i++) {
      const now = (await retry(() => sdk.identities.balance(id.identityId))) ?? 0n;
      if (now > before) return { identityId: id.identityId, assetLock: lock.txid, duffs, balanceBefore: before, balanceAfter: now };
      await sleep(3000);
    }
    throw new Error('top-up broadcast, but the proved balance did not increase');
  }

  async showIdentity(identityId) {
    await this.sync();
    const id = this.identity(identityId);
    const sdk = await this.sdk(id.network);
    const proved = await retry(() => sdk.identities.fetchWithProof(id.identityId));
    assert(proved.data, 'identity not found');
    const keys = proved.data.publicKeys.map((k) => {
      const j = k.toJSON();
      const data = Buffer.from(j.data, 'base64').toString('hex');
      const local = id.keys[j.id];
      return { id: j.id, type: j.type, purpose: j.purpose, securityLevel: j.securityLevel, disabledAt: j.disabledAt ?? null, publicKey: data, slot: local?.slot ?? null, matchesGroupKey: local ? local.publicKey === data : false };
    });
    const balance = await retry(() => sdk.identities.balance(id.identityId));
    return toPlain({ identityId: id.identityId, network: id.network, revision: proved.data.revision, balance, keys, proofHeight: proved.metadata?.height ?? null });
  }
}
