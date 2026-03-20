#!/bin/bash
# Kills the dev server, restarts it, creates a fresh company + CEO + task, opens chat.
# Usage: ./scripts/dev-fresh-chat.sh [company-name]

set -e
cd "$(dirname "$0")/.."

BASE="http://127.0.0.1:3000/api"
NAME="${1:-Dev Test $(date +%H%M%S)}"

# Kill existing server
echo "Killing existing server..."
lsof -ti:3000 | xargs kill -9 2>/dev/null || true
sleep 1
lsof -ti:3000 | xargs kill -9 2>/dev/null || true
sleep 1

# Start dev server in background
echo "Starting dev server..."
npm run dev > /tmp/paperclip-dev.log 2>&1 &
DEV_PID=$!

# Wait for server to be ready
echo -n "Waiting for server"
for i in $(seq 1 30); do
  if curl -s "$BASE/health" > /dev/null 2>&1; then
    echo " ready!"
    break
  fi
  echo -n "."
  sleep 1
  if [ "$i" -eq 30 ]; then
    echo " timed out! Check /tmp/paperclip-dev.log"
    exit 1
  fi
done

# Archive old test companies (keep "strata" and "faceless")
echo "Cleaning up old companies..."
COMPANIES=$(curl -s "$BASE/companies")
echo "$COMPANIES" | python3 -c "
import sys, json
companies = json.load(sys.stdin)
keep = {'strata', 'faceless'}
for c in companies:
    name_lower = c.get('name', '').lower()
    if not any(k in name_lower for k in keep) and not c.get('archivedAt'):
        cid = c['id']
        print(f\"  archiving: {c['name']} ({cid})\")
" 2>/dev/null | while read -r line; do echo "$line"; done

# Actually archive them
echo "$COMPANIES" | python3 -c "
import sys, json
companies = json.load(sys.stdin)
keep = {'strata', 'faceless'}
for c in companies:
    name_lower = c.get('name', '').lower()
    if not any(k in name_lower for k in keep) and not c.get('archivedAt'):
        print(c['id'])
" 2>/dev/null | while read -r CID; do
  curl -s -X POST "$BASE/companies/$CID/archive" > /dev/null 2>&1 || true
done

MISSION="Create educational and news content about AI (technology, use cases, applications, policies) for elderly audiences on a faceless YouTube channel. Goal: \$5k MRR in passive income within 6 months."

echo "Creating company: $NAME"
COMPANY=$(curl -s -X POST "$BASE/companies" \
  -H "Content-Type: application/json" \
  -d "{\"name\": \"$NAME\"}")

COMPANY_ID=$(echo "$COMPANY" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
PREFIX=$(echo "$COMPANY" | python3 -c "import sys,json; print(json.load(sys.stdin)['issuePrefix'])")
echo "  id: $COMPANY_ID  prefix: $PREFIX"

echo "Setting company mission..."
curl -s -X POST "$BASE/companies/$COMPANY_ID/goals" \
  -H "Content-Type: application/json" \
  -d "{\"title\": \"$MISSION\", \"level\": \"company\"}" > /dev/null

echo "Creating CEO agent..."
AGENT=$(curl -s -X POST "$BASE/companies/$COMPANY_ID/agents" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "CEO",
    "role": "ceo",
    "adapterType": "claude_local",
    "adapterConfig": {},
    "runtimeConfig": {
      "heartbeat": { "enabled": false, "intervalSec": 3600, "wakeOnDemand": false, "cooldownSec": 10, "maxConcurrentRuns": 1 }
    }
  }')

AGENT_ID=$(echo "$AGENT" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
echo "  agent id: $AGENT_ID"

# Create a lightweight chat task (needed for the comment system)
echo "Creating chat task..."
TASK=$(curl -s -X POST "$BASE/companies/$COMPANY_ID/issues" \
  -H "Content-Type: application/json" \
  -d "{
    \"title\": \"Chat with CEO\",
    \"description\": \"CEO onboarding conversation. Company mission: $MISSION\",
    \"status\": \"in_progress\",
    \"assigneeAgentId\": \"$AGENT_ID\"
  }")

TASK_ID=$(echo "$TASK" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
echo "  task id: $TASK_ID"

URL="http://localhost:3000/$PREFIX/chat?taskId=$TASK_ID"
echo ""
echo "Ready! Open:"
echo "  $URL"
echo ""
echo "Server log: /tmp/paperclip-dev.log"
echo "Server PID: $DEV_PID"

# Try to open in browser
if command -v open &>/dev/null; then
  open "$URL"
fi
