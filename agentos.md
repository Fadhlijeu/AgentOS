AGENTOS — MASTER BUILD PROMPT

0. ROLE

You are the lead software architect and implementation engineer for a project called AgentOS.

Your job is to build a general-purpose, reusable agent runtime/platform that can be embedded into many future projects.

AgentOS is NOT a chatbot application.

AgentOS is NOT a single-purpose browser agent.

AgentOS is NOT a clone of one existing project.

AgentOS is a general agent execution layer providing:

- agent runtime
- reasoning/action loop
- planning
- tools
- memory
- state
- event system
- permissions
- human approval
- execution
- observability
- persistence
- retries
- recovery
- replay
- extensibility

Future applications should be able to reuse AgentOS rather than reimplementing agent logic.

---

1. ABSOLUTE IMPLEMENTATION RULE

VERY IMPORTANT: DO NOT REINVENT EXISTING OPEN-SOURCE PROJECTS

When an existing open-source repository is identified as a source implementation, reference implementation, dependency, fork candidate, or reusable subsystem, DO NOT manually recreate its files from memory or write an approximate replacement.

Instead:

1. Inspect the actual repository.
2. Clone it with git.
3. Preserve the original repository structure where appropriate.
4. Preserve implementation details where we intend to reuse them.
5. Preserve upstream LICENSE and attribution.
6. Record exact upstream repository URL and commit/tag/version.
7. Reuse the actual source code or dependency whenever the license allows it.
8. Modify only what is necessary.
9. Do NOT silently rewrite an existing repository into an approximate homemade implementation.
10. If a file exists upstream and we need it, COPY/IMPORT/USE THE ACTUAL FILE rather than "recreating something equivalent".

REQUIRED BEHAVIOR

If instructed to reuse a repository:

DO:

git clone <repository-url>

or use git submodule/subtree/fork/package dependency when appropriate.

DO NOT:

"Let's implement something similar."
"Let's recreate the architecture."
"Let's write our own version of this file."

unless the task explicitly asks for a clean-room implementation.

IF CLONING FAILS

Do NOT immediately remake the project from scratch.

First:

1. Retry.
2. Inspect git configuration.
3. Try shallow clone.
4. Try downloading the repository archive.
5. Try fetching individual required files/directories.
6. Check whether the repository is accessible.
7. Report exactly what failed.

Only create a new implementation when explicitly authorized.

---

2. OPEN-SOURCE PROVENANCE RULE

Every reused external project MUST be tracked.

Create:

THIRD_PARTY.md

containing:

Project:
Repository:
Upstream URL:
License:
Original version/commit:
What is reused:
What was modified:
Attribution:

Preserve:

LICENSE
NOTICE
LICENSE-THIRD-PARTY.md

where required.

Never remove copyright notices from reused code.

Before copying or embedding code, verify the repository license.

Do not assume all repositories have compatible licenses.

---

3. PRIMARY PROJECT VISION

Project name:

AgentOS

Tagline:

«The runtime for AI agents that operate computers.»

Core philosophy:

Brain

- Hands
- Nervous System

Brain

LLM
Planner
Reasoning
Memory
Context
Task decomposition

Hands

Browser
Filesystem
Terminal
Computer
HTTP/API
Applications
MCP tools
Custom tools

Nervous System

State
Events
Permissions
Policy
Approvals
Execution
Recovery
Observability
Replay
Persistence

The AgentOS core must remain domain-agnostic.

It should not care whether an agent is being used for:

- coding
- browsing
- research
- automation
- file management
- data analysis
- customer support
- desktop automation
- business workflows
- testing
- other future domains

Only tools, context, policies, and environment should change.

---

4. CORE DESIGN PRINCIPLE

The following must be possible:

const agent = new Agent({
model,
tools: [
browser(),
filesystem(),
terminal()
]
});

await agent.run(
"Find the latest PDF in Downloads, summarize it, and save the result to Documents."
);

A completely different application must also be able to do:

const agent = new Agent({
model,
tools: [
github(),
terminal(),
filesystem()
]
});

and reuse the SAME core reasoning/runtime system.

---

5. PROJECTS TO DIRECTLY REUSE / CLONE

These repositories are not merely inspiration.

Treat them as actual implementation sources to inspect and reuse where appropriate.

---

5.1 OpenHands Software Agent SDK

Repository:

https://github.com/OpenHands/software-agent-sdk

Use this as a major implementation reference and potential reusable upstream component for:

- agent architecture
- reasoning/action loop
- tools
- workspace abstraction
- conversations
- events
- server architecture
- SDK design
- execution model
- security validation

The current OpenHands SDK explicitly provides modular agent infrastructure around agents, tools, conversations, workspaces, events, APIs, and server execution.

REQUIRED ACTION

Clone the repository before designing AgentOS internals around it.

Example:

git clone https://github.com/OpenHands/software-agent-sdk.git

Then inspect:

agent
tools
workspace
conversation
events
server
security

Do not rebuild these blindly.

Determine:

- what can be directly reused
- what can be wrapped
- what should become an AgentOS adapter
- what should remain independent

Prefer composition over unnecessary rewriting.

License currently shown by the repository: MIT. Verify the exact upstream license in the checked-out version before redistribution.

---

5.2 Browser Use

Repository:

https://github.com/browser-use/browser-use

This is the primary reference/reuse candidate for browser-agent capabilities.

Current repository scale and activity make it a significant existing implementation rather than something we should recreate.

REQUIRED ACTION

Clone:

git clone https://github.com/browser-use/browser-use.git

Inspect the actual implementation.

Do NOT create a homemade browser-agent implementation simply because implementing one seems straightforward.

Reuse or integrate it through:

AgentOS Browser Tool
↓
Browser Engine Adapter
↓
Browser Use

Potential interface:

interface BrowserEngine {
launch(): Promise<BrowserSession>;
attach(): Promise<BrowserSession>;
open(url: string): Promise<void>;
observe(): Promise<BrowserObservation>;
act(action: BrowserAction): Promise<ActionResult>;
close(): Promise<void>;
}

Then implement adapters rather than duplicating browser logic.

---

5.3 Open Interpreter

Repository:

https://github.com/openinterpreter/openinterpreter

Use the actual implementation as a reusable/reference source for:

- local execution
- terminal/code execution
- computer interaction
- harness concepts
- sandboxing
- approvals
- local agent workflows

The current project is Rust-based and has sandbox/approval and multiple harness concepts, so inspect the current codebase rather than relying on historical Python architecture.

Clone:

git clone https://github.com/openinterpreter/openinterpreter.git

Do not rewrite its execution layer from scratch.

AgentOS should expose something like:

terminal()
code()
computer()

with adapters around the underlying execution implementation.

Current repository license is Apache-2.0; verify the exact checked-out version before redistribution.

---

5.4 Open Browser Use

Repository:

https://github.com/open-browser-use/open-browser-use

Use this for:

- existing browser sessions
- browser extension integration
- local-first browser control
- MCP integration
- browser session persistence
- capability gating
- policy enforcement
- browser security patterns

The current repository directly targets controlling the user's already-running browser and exposes an MCP-oriented architecture with a local broker, browser backends, SDK, and policy/guard mechanisms.

Clone:

git clone https://github.com/open-browser-use/open-browser-use.git

Treat it as an actual component/reuse candidate.

Current repository indicates MIT licensing, but still verify the checked-out LICENSE and third-party licenses.

---

5.5 USER-OWNED COMPONENTS

The user has existing projects that are relevant:

https://github.com/fadhlijeu/DeepDOM-Agent
https://github.com/fadhlijeu/deep-browser

These are NOT third-party components.

Treat them as first-party modules that can be integrated directly.

Potential future architecture:

AgentOS
│
├── Agent Runtime
├── Tool System
├── Security
├── Memory
├── Events
│
└── Browser Layer
├── DeepDOM
├── deep-browser
├── Browser Use adapter
└── Open Browser Use adapter

Do not duplicate DeepDOM capabilities unnecessarily.

Prefer extracting reusable interfaces or importing existing modules.

---

6. REFERENCE ARCHITECTURE

Target:

                         AGENTOS
                            │
             ┌──────────────┴──────────────┐
             │                             │
      Agent Runtime                  Control Plane
             │                             │
      ┌──────┼────────┐             ┌──────┼──────┐
      │      │        │             │      │      │

Planner Memory Context Policy Events State
│
▼
Tools
│
┌────┼─────────────┬─────────────┐
▼ ▼ ▼ ▼
Web Files Terminal Computer
│
├── DeepDOM
├── Browser Use
└── Open Browser Use

---

7. REPOSITORY STRATEGY

Use a monorepo unless there is a strong reason not to.

Suggested structure:

agentos/
│
├── apps/
│ ├── desktop/
│ └── playground/
│
├── packages/
│ ├── core/
│ ├── agent/
│ ├── planner/
│ ├── memory/
│ ├── tools/
│ ├── permissions/
│ ├── events/
│ ├── runtime/
│ ├── storage/
│ ├── observability/
│ ├── sdk/
│ └── adapters/
│
├── integrations/
│ ├── openhands/
│ ├── browser-use/
│ ├── open-browser-use/
│ ├── deepdom/
│ ├── deep-browser/
│ └── open-interpreter/
│
├── third-party/
│
├── docs/
│
├── examples/
│
├── tests/
│
├── THIRD_PARTY.md
├── ARCHITECTURE.md
├── SECURITY.md
└── README.md

---

8. IMPORTANT: CLONE STRATEGY

Whenever the task requires importing/reusing a repository:

STEP 1

Check whether repository already exists locally.

STEP 2

If not, clone it.

STEP 3

Verify commit/tag.

STEP 4

Verify LICENSE.

STEP 5

Record provenance.

STEP 6

Only THEN begin integration.

NEVER DO THIS

"Unable to clone → I'll recreate the files."

DO THIS

"Clone failed → diagnose → retry → archive/download → report."

---

9. AGENT CORE

Implement or reuse a core abstraction equivalent to:

interface Agent {
run(task: string): Promise<AgentResult>;
pause(): Promise<void>;
resume(): Promise<void>;
cancel(): Promise<void>;
}

The agent runtime must support:

observe
→ reason
→ plan
→ act
→ verify
→ remember
→ repeat

The loop must be pluggable.

Do not hardcode one LLM provider.

---

10. MODEL ABSTRACTION

Support multiple LLM providers.

Create:

interface ModelProvider {
generate(request: ModelRequest): Promise<ModelResponse>;
}

Never make AgentOS depend permanently on one vendor.

Provider examples:

OpenAI
Anthropic
Gemini
OpenRouter
local models
custom endpoint

---

11. TOOL SYSTEM

Every capability must be a tool.

Example:

interface Tool<Input, Output> {
name: string;
description: string;
inputSchema: Schema;
riskLevel: RiskLevel;
execute(input: Input, ctx: ToolContext): Promise<Output>;
}

Examples:

browser.open
browser.click
browser.type

filesystem.read
filesystem.write
filesystem.move

terminal.exec

computer.click
computer.type
computer.screenshot

http.request

Tool metadata MUST include permission requirements.

---

12. PERMISSION SYSTEM

Implement capability-based permissions.

Example:

filesystem:
read: - ~/Downloads
write: - ~/Documents/AgentOS

terminal:
allow: - git - npm - pnpm - python

browser:
allow_origins: - https://github.com

Never give unrestricted access by default in dangerous modes.

---

13. HUMAN APPROVAL

Risk levels:

LOW
MEDIUM
HIGH
CRITICAL

Example:

LOW
→ automatic

MEDIUM
→ automatic + log

HIGH
→ ask user

CRITICAL
→ always require approval

The approval mechanism must be implemented at the AgentOS level rather than independently inside every tool.

---

14. EVENT SYSTEM

Every important operation must produce events.

Examples:

agent.started
task.started
plan.created
tool.requested
tool.started
tool.completed
tool.failed
approval.required
approval.granted
approval.denied
memory.updated
agent.paused
agent.resumed
task.completed
task.failed

Events should be serializable and persisted.

---

15. OBSERVABILITY

Every task must be inspectable.

A task trace should show:

Task
↓
Plan
↓
LLM decision
↓
Tool call
↓
Tool result
↓
Observation
↓
Next action

Store:

timestamp
task_id
run_id
agent_id
tool
arguments
result
error
latency
model
tokens
permission decision

---

16. REPLAY

Implement task replay.

A completed run should be exportable.

Example:

{
"runId": "abc123",
"task": "...",
"events": []
}

The system should make it possible to inspect and replay execution.

Replay should be deterministic where the underlying environment allows it.

---

17. MEMORY

At minimum:

Working Memory
Long-Term Memory
Semantic Memory

Working memory:

current task
current observations
current plan

Long-term:

preferences
facts
previous outcomes

Semantic:

embeddings
retrieval
knowledge

Memory must be replaceable through an adapter.

---

18. WORKSPACE ABSTRACTION

AgentOS must support multiple workspace types.

interface Workspace {
read(...);
write(...);
list(...);
delete(...);
exists(...);
}

Potential implementations:

LocalWorkspace
DockerWorkspace
RemoteWorkspace
TemporaryWorkspace

Reuse OpenHands workspace concepts where useful rather than recreating equivalent machinery.

---

19. BROWSER ABSTRACTION

AgentOS must not become permanently tied to a single browser engine.

Create:

interface BrowserProvider {
createSession(): Promise<BrowserSession>;
}

Possible providers:

DeepDOM
deep-browser
Browser Use
Open Browser Use
Playwright

Adapters should translate AgentOS actions into provider-specific actions.

---

20. DESKTOP APPLICATION

After the core runtime works, create a desktop UI.

The UI should show:

Tasks
Active Agent
Browser/Computer View
Current Action
Tool Calls
Logs
Permissions
Approval Dialog
Memory
Run Replay

Do not let UI logic become tightly coupled with the agent core.

The UI should consume AgentOS APIs/events.

---

21. FIRST MVP

Do NOT implement the entire vision immediately.

First milestone:

AgentOS v0.1

Must support:

✓ Agent
✓ Model abstraction
✓ Tool system
✓ Planner / reasoning loop
✓ Filesystem tool
✓ Terminal tool
✓ Browser adapter
✓ Permissions
✓ Human approval
✓ Event system
✓ SQLite persistence
✓ Task execution
✓ Basic replay/logging

The MVP must successfully perform:

"Find a PDF in Downloads, summarize it, and write the summary to Documents."

and:

"Open a website, search for information, and save the result to a file."

---

22. SECOND MILESTONE

AgentOS v0.2:

✓ Memory
✓ Scheduler
✓ Retry
✓ Error recovery
✓ Long-running tasks
✓ Multi-agent support
✓ Better browser integration
✓ Replay UI
✓ Observability UI

---

23. THIRD MILESTONE

AgentOS v1:

✓ SDK
✓ Desktop application
✓ Plugin system
✓ MCP integration
✓ Remote runtime
✓ Sandboxed execution
✓ Agent marketplace/plugin ecosystem
✓ Agent-to-agent orchestration

---

24. FUTURE REUSE

AgentOS must be designed so future projects can import it.

Example:

import { Agent, tools } from "@agentos/core";

const agent = new Agent({
tools: [
tools.browser(),
tools.filesystem(),
tools.github()
]
});

Potential future projects:

Coding Agent
Research Agent
Browser Agent
Desktop Agent
Automation Agent
DevOps Agent
Testing Agent
Data Agent
Personal Assistant

All should reuse the same runtime.

---

25. DO NOT CREATE THESE DUPLICATES

Do NOT unnecessarily recreate:

browser automation engine
LLM provider SDK
MCP protocol
terminal shell implementation
browser extension protocol
existing agent runtime
existing sandbox implementation
existing orchestration framework

Use upstream projects, adapters, wrappers, or dependencies where appropriate.

AgentOS should provide the integration layer.

---

26. CODE QUALITY

Requirements:

- typed
- modular
- testable
- observable
- documented
- secure
- minimal coupling
- explicit interfaces
- graceful error handling
- cancellation support
- retries where appropriate
- structured logging

Do not prematurely optimize.

Prefer understandable architecture.

---

27. SECURITY REQUIREMENTS

Security is a first-class feature.

At minimum:

capability permissions
path restrictions
command restrictions
origin restrictions
approval policies
secret redaction
audit logs
sandbox support

Never expose raw secrets to the LLM unnecessarily.

Never allow unrestricted shell access merely because the model requested it.

---

28. DEVELOPMENT PROCESS

Before writing major amounts of code:

1. Inspect existing repositories.
2. Clone required upstream repositories.
3. Determine reusable components.
4. Build dependency/provenance map.
5. Write ARCHITECTURE.md.
6. Define interfaces.
7. Implement smallest working vertical slice.
8. Add tests.
9. Integrate upstream components.
10. Expand incrementally.

Do NOT generate a giant fake codebase in one step.

Build working increments.

---

29. ERROR HANDLING FOR CODING AGENT

When a file is missing:

DO NOT silently generate a replacement.

Instead:

1. Check git status.
2. Check repository history.
3. Search exact filename.
4. Search branch/tag.
5. Fetch upstream.
6. Restore file if appropriate.
7. Verify diff.

When a repository is needed:

1. git clone
2. verify
3. inspect
4. reuse

When an external implementation is referenced:

PREFER:
actual source
git dependency
submodule
subtree
package dependency
adapter

OVER:
handwritten recreation

---

30. DIFFERENCE BETWEEN "CLONE" AND "BUILD"

CLONE / REUSE PROJECT

Use actual source.

Examples:

OpenHands SDK
Browser Use
Open Interpreter
Open Browser Use

Preserve provenance and license.

BUILD AGENTOS

AgentOS itself is our original integration/runtime project.

It may borrow design concepts, interfaces, and compatible abstractions, but it should not falsely claim upstream code as original.

USER PROJECTS

DeepDOM and deep-browser are first-party.

Reuse them directly.

---

31. RECOMMENDED TECHNICAL DIRECTION

Preferred initial architecture:

TypeScript
Node.js
pnpm workspace
SQLite
Zod
Electron later

But do not force a technology when an upstream implementation already solves the problem better.

For example:

Rust upstream
→ keep Rust if appropriate

Python upstream
→ keep Python if appropriate

TypeScript AgentOS
→ communicate through adapters/processes/APIs

Do NOT rewrite a mature Rust/Python component just to make the entire project one language.

---

32. GOLDEN RULE

The most important instruction:

«Reuse working software before reinventing it.»

When a repository already implements a capability, your first instinct must be:

Can we clone it?
Can we fork it?
Can we depend on it?
Can we wrap it?
Can we adapt it?
Can we use it as a submodule?

Only after those answers are no should you implement a replacement.

---

33. FINAL ARCHITECTURAL TARGET

The desired end state:

                           AGENTOS
                              │
                 ┌────────────┴────────────┐
                 │                         │
           AGENT RUNTIME              CONTROL PLANE
                 │                         │
         ┌───────┼────────┐          ┌─────┼─────┐
         │       │        │          │     │     │
      Planner  Memory   Context    Policy Events State
         │
         ▼
       TOOLS
         │

┌───────┼────────────┬───────────────┐
▼ ▼ ▼ ▼
WEB FILES TERMINAL COMPUTER
│
├── DeepDOM
├── deep-browser
├── Browser Use
└── Open Browser Use

External execution/runtime candidates:
OpenHands
Open Interpreter
MCP
Docker/Sandbox

The final product should feel like:

«Linux/process runtime concepts + agent framework + computer-use capabilities + security/control plane»

but for AI agents.

---

34. DEFINITION OF DONE

AgentOS is successful when a completely new application can say:

import { Agent } from "@agentos/core";

const agent = new Agent({
model,
tools: [...]
});

await agent.run(task);

without implementing its own:

reasoning loop
planning
tool orchestration
permissions
approval
state
event logging
memory
retry
recovery
replay

That is the core purpose of AgentOS.

---

35. START NOW

Begin by:

1. Inspecting the current workspace.
2. Creating a dependency/provenance map.
3. Cloning the selected upstream repositories rather than recreating them.
4. Checking licenses.
5. Creating "THIRD_PARTY.md".
6. Creating "ARCHITECTURE.md".
7. Creating the initial monorepo.
8. Building AgentOS v0.1 as the smallest end-to-end working vertical slice.
9. Reusing actual upstream implementations through adapters wherever practical.
10. Running tests after every major integration.

Do not produce mock implementations when a real upstream implementation can be obtained.

Do not replace missing cloned files with handwritten approximations.

Do not silently simplify upstream projects.

Do not silently remove upstream functionality.

When uncertain, inspect the actual source tree and dependency graph first.

also build a repository, change: always commit & push
