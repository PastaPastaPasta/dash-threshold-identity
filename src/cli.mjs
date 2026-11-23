import fs from 'node:fs';
import readline from 'node:readline';
import { parseArgs } from 'node:util';
import { Session } from './app.mjs';
import { listRooms, loadRoom, exportBundle, importBundle } from './store.mjs';
import { serveRelay } from './relay/node-server.mjs';
import { DEFAULT_KEYS } from './ceremony.mjs';
import { jsonReplacer } from './util.mjs';

const HELP = `dti: threshold BLS identities for Dash Platform

Every key comes from your BIP39 seed phrase. Give it with DTI_MNEMONIC, --mnemonic-file, or at the prompt.
An optional BIP39 passphrase comes from DTI_PASSPHRASE or --passphrase-file.

  dti whoami                                   your participant key and fingerprint
  dti room create --label L --name N [--relay URL]
  dti room join ROOM --name N [--relay URL]
  dti room export [--out FILE]                 write the room's signed messages as a bundle
  dti room import FILE                         merge a bundle (signatures are checked)
  dti rooms                                    rooms on this machine
  dti status [--json]                          members, ceremonies, identities, proposals
  dti sync

  dti ceremony propose --network mainnet|testnet|devnet-NAME|local --threshold T --label L [--members a,b,..] [--keys FILE]
  dti ceremony advance [--cid C] [--yes]       take the next step of the key ceremony
  dti ceremony run [--cid C] [--yes]           keep stepping until the keys exist
  dti ceremony show [--cid C]

  dti fund address --network N                 your Core funding address (from your seed) and balance
  dti fund locks --network N                   asset locks your seed funded, found on chain, and whether each is used
  dti identity create [--cid C] --duffs D      funder: lock D duffs and propose the identity (mainnet: --confirm-mainnet)
       (an earlier unused lock found on chain is resumed instead; --new-lock skips that, --index N picks one)
  dti identity show [--identity ID]            proved read: on-chain keys vs the group keys
  dti identity topup [--identity ID] --duffs D

  dti propose contract-create --schema FILE [--signer critical]
  dti propose contract-update --contract ID --schema FILE [--signer critical]
  dti propose document --contract ID --type T --action create|replace|delete [--data JSON] [--id DOC] [--signer high]
  dti propose transfer --to ID --amount CREDITS [--signer transfer]
  dti propose withdraw --to-address ADDR --amount CREDITS [--signer transfer]
  dti propose update-identity [--add CID/SLOT,..] [--disable KEYID,..] [--signer master]
       (all propose commands take [--identity ID] [--fee-increase N] [--note TEXT])
  dti review PROPOSAL                          rebuild, decode and check a proposal
  dti approve PROPOSAL [--yes] [--offline]     review, then contribute your signature share (mainnet: --confirm-mainnet)
       (--accept-new-keys: required when the proposal puts keys under a ceremony's control)
  dti reject PROPOSAL --reason TEXT
  dti execute PROPOSAL                         combine the shares and broadcast (mainnet: --confirm-mainnet)

  dti relay serve [--port 8787] [--host 127.0.0.1] [--dir DIR] [--limits]
  dti ui [--port 8770]                         local web UI (served on 127.0.0.1 only)

Options: --room ROOM (or DTI_ROOM), --relay URL, --json`;

const OPTIONS = {
  'new-lock': { type: 'boolean' },
  room: { type: 'string' }, relay: { type: 'string' }, label: { type: 'string' }, name: { type: 'string' },
  network: { type: 'string' }, threshold: { type: 'string' }, members: { type: 'string' }, keys: { type: 'string' },
  cid: { type: 'string' }, yes: { type: 'boolean' }, json: { type: 'boolean' }, out: { type: 'string' },
  duffs: { type: 'string' }, index: { type: 'string' }, identity: { type: 'string' }, schema: { type: 'string' },
  contract: { type: 'string' }, type: { type: 'string' }, action: { type: 'string' }, data: { type: 'string' }, id: { type: 'string' },
  signer: { type: 'string' }, to: { type: 'string' }, 'to-address': { type: 'string' }, amount: { type: 'string' },
  add: { type: 'string' }, disable: { type: 'string' }, 'fee-increase': { type: 'string' }, note: { type: 'string' },
  reason: { type: 'string' }, port: { type: 'string' }, host: { type: 'string' }, dir: { type: 'string' },
  'confirm-mainnet': { type: 'boolean' }, 'accept-new-keys': { type: 'boolean' }, 'mnemonic-file': { type: 'string' }, 'passphrase-file': { type: 'string' }, offline: { type: 'boolean' }, limits: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
};

const print = (v, asJson) => console.log(asJson || typeof v !== 'string' ? JSON.stringify(v, jsonReplacer, 2) : v);
const readFile = (f) => fs.readFileSync(f, 'utf8').trim();

async function hidden(question) {
  if (!process.stdin.isTTY) throw new Error('no seed phrase: set DTI_MNEMONIC or pass --mnemonic-file');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  rl._writeToOutput = (s) => { if (s.includes(question)) process.stdout.write(s); };
  const answer = await new Promise((r) => rl.question(question, r));
  rl.close();
  process.stdout.write('\n');
  return answer;
}

async function ask(question) {
  if (!process.stdin.isTTY) return '';
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  const answer = await new Promise((r) => rl.question(question, r));
  rl.close();
  return answer.trim();
}

async function session(v, { needRoom = true } = {}) {
  const mnemonic = process.env.DTI_MNEMONIC || (v['mnemonic-file'] ? readFile(v['mnemonic-file']) : await hidden('Seed phrase: '));
  const passphrase = process.env.DTI_PASSPHRASE ?? (v['passphrase-file'] ? readFile(v['passphrase-file']) : '');
  let room = v.room ?? process.env.DTI_ROOM;
  if (!room && needRoom) {
    const rooms = listRooms();
    if (rooms.length === 1) room = rooms[0].room;
    else throw new Error(rooms.length ? `several rooms here; pass --room (${rooms.map((r) => r.room).join(', ')})` : 'no room yet: dti room create or dti room join');
  }
  return new Session({ mnemonic, passphrase, room: needRoom ? room : undefined, relay: v.relay, log: (m) => console.error(`· ${m}`) });
}

const confirmCeremony = (yes) => async (c) => {
  console.error(`\nCeremony ${c.cid}\n  ${c.config.label} on ${c.config.network}, ${c.config.threshold}-of-${c.config.participants.length}`);
  for (const p of c.config.participants) console.error(`  ${p.index}. ${p.name.padEnd(16)} ${p.authPub.slice(0, 16)}…`);
  for (const k of c.config.keys) console.error(`  key ${k.keyId}: ${k.slot} ${k.purpose}/${k.securityLevel}`);
  console.error('Check every member\'s fingerprint with them out of band (dti status) before accepting.');
  return yes || (await ask('Accept? [y/N] ')).toLowerCase() === 'y';
};

const confirmApproval = (yes) => async (report) => {
  console.error(`\nProposal ${report.id} from ${report.proposer}`);
  for (const line of report.summary) console.error(`  ${line}`);
  console.error(`\nThe exact transition (${report.decoded?.action}):\n${JSON.stringify(report.decoded?.json, jsonReplacer, 2)}`);
  for (const a of report.attention) console.error(`\n  ATTENTION: ${a}`);
  for (const w of report.warnings) console.error(`  warning: ${w}`);
  return yes || (await ask('Sign? [y/N] ')).toLowerCase() === 'y';
};

const list = (s) => (s ? s.split(',').map((x) => x.trim()).filter(Boolean) : []);
const contractFromFile = (file) => {
  const def = JSON.parse(readFile(file));
  return def.documentSchemas ? def : { documentSchemas: def };
};

export async function main(argv) {
  const { values: v, positionals: pos } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  const [cmd, sub, arg] = pos;
  if (v.help || !cmd || cmd === 'help') return print(HELP);

  switch (cmd) {
    case 'whoami': return print((await session(v, { needRoom: false })).whoami(), v.json);
    case 'rooms': return print(listRooms(), true);
    case 'room': {
      if (sub === 'import') {
        const { data, added } = importBundle(JSON.parse(readFile(arg)));
        return print({ room: data.room, added }, true);
      }
      if (sub === 'export') {
        const s = await session(v);
        const bundle = JSON.stringify(exportBundle(loadRoom(s.data.room)), null, 1);
        if (v.out) fs.writeFileSync(v.out, bundle);
        else console.log(bundle);
        return;
      }
      const s = await session(v, { needRoom: false });
      if (sub === 'create') return print(await s.createRoom({ label: v.label, relay: v.relay, name: v.name ?? v.label }), true);
      if (sub === 'join') return print(await s.joinRoom({ room: arg ?? v.room, relay: v.relay, name: v.name }), true);
      break;
    }
    case 'sync': { const s = await session(v); return print(await s.sync(), true); }
    case 'status': {
      const s = await session(v);
      await s.sync().catch((e) => console.error(`· relay: ${e.message}`));
      return print(s.status(), true);
    }
    case 'ceremony': {
      const s = await session(v);
      if (sub === 'propose') {
        const keys = v.keys ? JSON.parse(readFile(v.keys)) : DEFAULT_KEYS;
        return print(await s.proposeCeremony({ network: v.network, threshold: Number(v.threshold), label: v.label, members: list(v.members), keys }), true);
      }
      if (sub === 'advance') return print(await s.advanceCeremony(v.cid, { confirm: confirmCeremony(v.yes) }), true);
      if (sub === 'run') return print(await s.runCeremony(v.cid, { confirm: confirmCeremony(v.yes) }), true);
      if (sub === 'show') return print(s.status().ceremonies.find((c) => !v.cid || c.cid.startsWith(v.cid)), true);
      break;
    }
    case 'fund': {
      const s = await session(v, { needRoom: false });
      if (sub === 'address') return print(await s.fundingBalance(v.network ?? 'testnet'), true);
      if (sub === 'locks') return print((await s.findAssetLocks(v.network ?? 'testnet')).map(({ rawtx, ...l }) => l), true);
      break;
    }
    case 'identity': {
      const s = await session(v);
      const lock = { duffs: Number(v.duffs), index: v.index ? Number(v.index) : undefined, newLock: Boolean(v['new-lock']), confirmMainnet: v['confirm-mainnet'] };
      if (sub === 'create') return print(await s.proposeIdentityCreate({ cid: v.cid, ...lock }), true);
      if (sub === 'show') return print(await s.showIdentity(v.identity), true);
      if (sub === 'topup') return print(await s.topUp({ identityId: v.identity, ...lock }), true);
      break;
    }
    case 'propose': {
      const s = await session(v);
      await s.sync();
      const c = { identityId: v.identity, userFeeIncrease: v['fee-increase'] ? Number(v['fee-increase']) : 0, note: v.note };
      switch (sub) {
        case 'contract-create': return print(await s.prepare('contract-create', { ...c, signer: v.signer ?? 'critical', contract: contractFromFile(v.schema) }), true);
        case 'contract-update': return print(await s.prepare('contract-update', { ...c, signer: v.signer ?? 'critical', contractId: v.contract, contract: contractFromFile(v.schema) }), true);
        case 'document': return print(await s.prepare('document', { ...c, signer: v.signer ?? 'high', contractId: v.contract, documentType: v.type, action: v.action, properties: v.data ? JSON.parse(v.data) : undefined, documentId: v.id }), true);
        case 'transfer': return print(await s.prepare('credit-transfer', { ...c, signer: v.signer ?? 'transfer', recipientId: v.to, amount: BigInt(v.amount) }), true);
        case 'withdraw': return print(await s.prepare('credit-withdrawal', { ...c, signer: v.signer ?? 'transfer', toAddress: v['to-address'], amount: BigInt(v.amount) }), true);
        case 'update-identity': return print(await s.prepare('identity-update', { ...c, signer: v.signer ?? 'master', addKeys: list(v.add).map((x) => { const [cid, slot] = x.split('/'); return { cid, slot }; }), disableKeyIds: list(v.disable).map(Number) }), true);
        default: break;
      }
      break;
    }
    case 'review': { const s = await session(v); return print(await s.review(sub, { online: !v.offline }), true); }
    case 'approve': { const s = await session(v); return print(await s.approve(sub, { confirm: confirmApproval(v.yes), online: !v.offline, acknowledgeKeys: Boolean(v['accept-new-keys']), confirmMainnet: Boolean(v['confirm-mainnet']) }), true); }
    case 'reject': { const s = await session(v); return print(await s.reject(sub, v.reason ?? ''), true); }
    case 'execute': { const s = await session(v); return print(await s.execute(sub, { confirmMainnet: Boolean(v['confirm-mainnet']) }), true); }
    case 'relay': {
      if (sub === 'serve') {
        const port = Number(v.port ?? 8787);
        const host = v.host ?? '127.0.0.1';
        await serveRelay({ port, host, dir: v.dir ?? null, limits: Boolean(v.limits) });
        console.error(`relay listening on http://${host}:${port}${v.dir ? ` (storing in ${v.dir})` : ' (in memory)'}${v.limits ? ', with per-address limits' : ''}`);
        return new Promise(() => {});
      }
      break;
    }
    case 'ui': {
      const { serveUi } = await import('./ui/server.mjs');
      const s = await session(v, { needRoom: false });
      if (!s.data && listRooms().length === 1) s.data = loadRoom(listRooms()[0].room);
      const url = await serveUi(s, { port: Number(v.port ?? 8770) });
      console.error(`web UI: ${url}`);
      return new Promise(() => {});
    }
    default: break;
  }
  throw new Error(`unknown command: ${pos.join(' ')} (dti help)`);
}
