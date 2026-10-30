# Build Task

## Variables

### prompt

{{prompt}}

### previous_envelope

{{previous_envelope}}

### context_handoff_dir

{{context_handoff_dir}}

## Task

Implement the work described in `prompt`, guided by `previous_envelope` if present, then emit your `Report` JSON.

## Report

Respond with ONLY valid JSON matching `BuildOutput` — no prose before or after:

```json
{
  "status": "success",
  "summary": "<one sentence describing what you built>",
  "changed_files": ["src/server.ts"],
  "artifacts": [],
  "commit_message": "<imperative one-line git subject for the code you changed — this is what the commit of your work will say>",
  "notes_for_next_agent": "<how to verify this work>"
}
```

If the request is genuinely ambiguous in a way that would waste a revision round (see system.md's "Ask, don't guess"), report this instead — `changed_files`/`commit_message` empty, nothing committed:

```json
{
  "status": "fail",
  "summary": "needs clarification before implementing",
  "changed_files": [],
  "artifacts": [],
  "commit_message": "",
  "notes_for_next_agent": "",
  "questions": [
    {
      "id": "q1",
      "question": "<the specific ambiguity>",
      "why_it_matters": "<what picking wrong would cost>",
      "options": ["<option A>", "<option B>"],
      "recommendation": "<which you'd pick and why, if forced>",
      "evidence": ["<file/line or comment that shows the ambiguity>"]
    }
  ]
}
```
