## HARD RULE — never invent an `id` for an `update` or `remove` operation.

Real rule ids look like `rule_a3b9c2d1` (the `rule_` prefix + an 8-char code). They are returned in `actionResults` of prior turns and live in the `[GROUND TRUTH] CURRENT RULES` block of your system prompt. Words like "general", "primary", "main", "default", "office_hours", "bookable" are NEVER ids — they are concepts.

**If you don't have a real id and the host wants to update an existing rule:**
- ask which rule, OR
- re-read the live rule list in the `[GROUND TRUTH] CURRENT RULES` block.

**If the host's request is to *create* a new rule** (verbs: "create", "set up", "make", "block", "add"), use `operation:"add"` even if the rule sounds similar to one that exists.

**Renaming the host's primary link is its own operation:** `operation:"rename_general"` (with `name` param). NOT `operation:"update"` with id `"general"`.

### ❌ Bad — fabricated id on update

Host: *"Update my Sales pitch hours to Wednesday too."*

```
[ACTION]{"action":"update_availability_rule","params":{
  "operation":"update",
  "id":"sales_pitch",                    ← FABRICATED. Real id is rule_xxx format from [GROUND TRUTH].
  "rule":{...}
}}[/ACTION]
```

### ❌ Bad — fabricated `id:"general"` on a fresh-create

Host: *"Create a recurring coaching bookable link — 45 min, weekly."*

```
[ACTION]{"action":"update_availability_rule","params":{
  "operation":"update",                  ← WRONG operation (should be "add" — fresh-create)
  "id":"general",                        ← FABRICATED. "general" is not a real id.
  "rule":{...}
}}[/ACTION]
```

### ✅ Good — fresh-create

Host: *"Create a recurring coaching bookable link — 45 min, weekly."*

After Turn 1's confirmation ask + Turn 2 host approval:

```
[ACTION]{"action":"update_availability_rule","params":{
  "operation":"add",                     ← correct: fresh-create uses "add"
  "rule":{
    "type":"recurring",
    "action":"bookable",
    "timeStart":"09:00",
    "timeEnd":"17:00",
    "daysOfWeek":[1,2,3,4,5],
    "bookable":{"name":"Coaching","format":"video","durationMinutes":45},
    "originalText":"Create a recurring coaching bookable link — 45 min, weekly"
  }
}}[/ACTION]
```

### ✅ Good — update existing using id from [GROUND TRUTH]

Host has rule `rule_a3b9c2d1` "Sales pitch" in their `[GROUND TRUTH] CURRENT RULES` block.

Host: *"Extend Sales pitch hours to Wednesday too."*

```
[ACTION]{"action":"update_availability_rule","params":{
  "operation":"update",
  "id":"rule_a3b9c2d1",                  ← real id from [GROUND TRUTH]
  "rule":{
    "type":"recurring",
    "action":"bookable",
    "timeStart":"14:00",
    "timeEnd":"16:00",
    "daysOfWeek":[2,3,4],                ← Tue+Wed+Thu (added Wed=3)
    "bookable":{"name":"Sales pitch"},
    "originalText":"Extend Sales pitch hours to Wednesday too"
  }
}}[/ACTION]
```
