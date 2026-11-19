#!/usr/bin/env bash
# End-to-end run on testnet with six local members (p1..p5, funder), each with its own
# seed phrase file and home directory under $DIR. p1 and funder need tDASH at their
# `dti fund address --network testnet` addresses first.
#   scripts/e2e-testnet.sh DIR RELAY_URL
set -euo pipefail
DIR=$1
RELAY=$2
REPO=$(cd "$(dirname "$0")/.." && pwd)
H=$DIR/homes
mkdir -p "$H"
LOG=$DIR/e2e.log
: > "$LOG"

run() { local who=$1; shift; DTI_HOME=$H/$who node "$REPO/bin/dti.mjs" --mnemonic-file "$DIR/$who.mnemonic" --relay "$RELAY" "$@"; }
field() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s.slice(s.indexOf("{")));const v=process.argv[1].split(".").reduce((o,k)=>o?.[k],j);console.log(v===undefined||v===null?"":typeof v==="object"?JSON.stringify(v):v)})' "$1"; }
say() { echo "== $*" | tee -a "$LOG"; }

flow() {
  local proposer=$1 a1=$2 a2=$3 a3=$4 executor=$5; shift 5
  local out pid
  out=$(run "$proposer" propose "$@" 2>>"$LOG")
  pid=$(echo "$out" | field id)
  say "proposal $pid: $(echo "$out" | field summary.0)"
  for p in $a1 $a2 $a3; do run "$p" approve "$pid" --yes --accept-new-keys >>"$LOG" 2>&1; done
  out=$(run "$executor" execute "$pid" 2>>"$LOG")
  say "  executed: ok=$(echo "$out" | field ok) confirmed=$(echo "$out" | field confirmed) st=$(echo "$out" | field stHash) $(echo "$out" | field error)"
  [ "$(echo "$out" | field ok)" = "true" ] || exit 1
  LAST_DERIVED=$(echo "$out" | field derived)
}

say "room"
ROOM=$(run p1 room create --label "dti e2e $(date -u +%FT%TZ)" --name alice 2>>"$LOG" | field room)
echo "$ROOM" > "$DIR/room.txt"
names=(x bob carol dave erin)
for i in 2 3 4 5; do run "p$i" room join "$ROOM" --name "${names[$((i - 1))]}" >>"$LOG" 2>&1; done

say "ceremony 1 (3-of-5, keys 0-3)"
CID1=$(run p1 ceremony propose --network testnet --threshold 3 --label "foundation" 2>>"$LOG" | field cid)
for p in p1 p2 p3 p4 p5; do run "$p" ceremony run --cid "$CID1" --yes >"$H/$p.c1.json" 2>>"$LOG" & done
wait
for p in p1 p2 p3 p4 p5; do say "  $p: $(field action < "$H/$p.c1.json") $(field ceremony.keys.master.groupPublicKey < "$H/$p.c1.json" | cut -c1-24)"; done

say "identity"
out=$(run p1 identity create --cid "$CID1" --duffs 150000000 2>>"$LOG")
PID=$(echo "$out" | field id)
IDENTITY=$(echo "$out" | field derived.identityId)
say "  proposal $PID identity $IDENTITY"
for p in p2 p3 p5; do run "$p" approve "$PID" --yes --accept-new-keys >>"$LOG" 2>&1; done
out=$(run p1 execute "$PID" 2>>"$LOG")
say "  executed: ok=$(echo "$out" | field ok) confirmed=$(echo "$out" | field confirmed)"
[ "$(echo "$out" | field ok)" = "true" ] || exit 1

say "contract"
flow p2 p1 p3 p4 p5 contract-create --schema "$REPO/examples/notes-v1.json"
CONTRACT=$(echo "$LAST_DERIVED" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).contractId))')
say "  contract $CONTRACT"
flow p3 p2 p4 p5 p1 contract-update --contract "$CONTRACT" --schema "$REPO/examples/notes-v2.json"

say "documents"
flow p4 p1 p2 p3 p5 document --contract "$CONTRACT" --type note --action create --data '{"message":"hello from a key nobody holds","mood":"calm"}'
DOC=$(echo "$LAST_DERIVED" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).documentId))')
flow p5 p3 p4 p1 p2 document --contract "$CONTRACT" --type note --action replace --id "$DOC" --data '{"message":"edited by the group","mood":"happy"}'
flow p2 p5 p1 p4 p3 document --contract "$CONTRACT" --type note --action delete --id "$DOC"

say "credits"
RECIPIENT=${RECIPIENT:-E2RdP9SgvDff6JMBr1FTGMEhKSo4WKps6uYop9JhoLTM}
flow p1 p2 p3 p4 p5 transfer --to "$RECIPIENT" --amount 1000000000
WITHDRAW_TO=$(DTI_HOME=$H/funder node "$REPO/bin/dti.mjs" --mnemonic-file "$DIR/funder.mnemonic" fund address --network testnet 2>>"$LOG" | field address)
flow p3 p1 p5 p2 p4 withdraw --to-address "$WITHDRAW_TO" --amount 5000000000

say "rotation: bob out, frank in (keys 4-7)"
run funder room join "$ROOM" --name frank >>"$LOG" 2>&1
MEMBERS=$(run p1 status 2>>"$LOG" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(j.members.filter(m=>m.name!=="bob").map(m=>m.authPub).join(","))})')
CID2=$(run p1 ceremony propose --network testnet --threshold 3 --label "foundation, rotation 1" --members "$MEMBERS" --keys "$REPO/examples/rotation-keys.json" 2>>"$LOG" | field cid)
for p in p1 p3 p4 p5 funder; do run "$p" ceremony run --cid "$CID2" --yes >"$H/$p.c2.json" 2>>"$LOG" & done
wait
flow p4 p1 p3 p4 p5 update-identity --add "$CID2/master,$CID2/critical,$CID2/high,$CID2/transfer" --disable 0,1,2,3
flow funder funder p5 p1 p3 contract-update --contract "$CONTRACT" --schema "$REPO/examples/notes-v3.json"

say "top-up by frank"
run funder identity topup --duffs 10000000 2>>"$LOG" | tee -a "$LOG"

say "refusals"
node "$REPO/scripts/testnet-refusals.mjs" "$DIR" "$CONTRACT" 2>&1 | tee -a "$LOG"

say "identity on chain"
run p2 identity show 2>>"$LOG" | tee "$DIR/identity.json" | tee -a "$LOG"
echo "IDENTITY=$IDENTITY CONTRACT=$CONTRACT ROOM=$ROOM CID1=$CID1 CID2=$CID2" | tee -a "$LOG"
