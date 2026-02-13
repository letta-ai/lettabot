# The Origin Story

Before I opened my laptop, the code had reviewed itself.

I launched GitHub expecting to dive into my usual routine—flag poorly named variables, trim excessive tests, and suggest simpler ways to handle errors. Instead, I found a few strong comments from Claude Code:

> "Changed variable naming to match pattern from PR #234, removed excessive test coverage per feedback on PR #219, added error handling similar to approved approach in PR #241."

Claude had learned from three prior months of code reviews and applied those lessons without being asked. It had picked up my tastes thoroughly, the way a sharp new teammate would—and with receipts.

It felt like cheating, but it wasn't—it was compounding.

## Building Cora

I built compound engineering while building Cora.

Cora is Every's AI email assistant. Every week I was shipping features, fixing bugs, handling edge cases in email parsing, adding integrations. The usual. Except I was doing it with Claude, and something felt different.

At first I was doing what everyone does: asking the AI to write some code, copying it, reviewing every line, fixing the mistakes. Standard workflow. But the code kept getting better. Not just because I was getting better at prompting—the AI was learning my codebase, my patterns, my preferences.

One day I noticed I hadn't actually written any code that week. I'd spent all my time planning features, reviewing what Claude produced, and documenting patterns. The features shipped anyway. Tests passed. Users were happy.

That's when it clicked.

## The Realization

The real strength isn't in the code you write. It's in the system you build around how you write code.

Every time I fixed something, I'd add context to CLAUDE.md. Every time I noticed a pattern, I'd create an agent for it. Every time I hit a recurring problem, I'd document the solution. The next day, Claude wouldn't make that mistake again.

This wasn't just AI assistance. This was compounding.

## What Compounding Means

In finance, compound interest means your returns generate their own returns. A dollar invested becomes two dollars, then four, then eight. The growth accelerates.

In engineering, compound work means each solution generates solutions to future problems. A pattern documented prevents ten future bugs. A review checklist catches issues before they become incidents. An agent trained on your codebase thinks like you do.

Traditional engineering is linear. You solve problem A, then problem B, then problem C. Each one takes roughly the same effort.

Compound engineering is exponential. You solve problem A, then you teach the system how you solved it. Problem B takes half the time. Problem C takes a quarter.

**Typical AI engineering** is about short-term gains. You prompt, it codes, you ship. Then you start over.

**Compound engineering** is about building systems with memory, where every pull request teaches the system, every bug becomes a permanent lesson, and every code review updates the defaults.

AI engineering makes you faster today. Compound engineering makes you faster tomorrow, and each day after.

## A Real Example: The Frustration Detector

Here's how compound engineering works in practice.

I'm building a "frustration detector" for Cora—the goal is for our AI assistant to notice when users get annoyed with the app's behavior and automatically file improvement reports.

Traditional approach: write the detector, test it manually, tweak, repeat. Lots of context-switching between thinking like a user and thinking like a developer.

Compound approach: I start with a sample conversation where I express frustration—like repeatedly asking the same question with increasingly terse language. Then I hand it to Claude: "This conversation shows frustration. Write a test that checks if our tool catches it."

Claude writes the test. Test fails—that's test-driven development. Claude writes the detection logic. It still doesn't work perfectly. Here's the beautiful part: I tell Claude to iterate on the frustration detection prompt until the test passes.

Claude adjusts the prompt and runs the test again. It reads the logs, sees why it missed a frustration signal, and adjusts again. After a few rounds, the test passes.

But AI outputs aren't deterministic—a prompt that works once might fail the next time. So I have Claude run the test 10 times. When it only identifies frustration in four out of 10 passes, Claude analyzes why it failed the other six times. It discovers a pattern: it's missing hedged language like "Hmm, not quite," which signals frustration when paired with repeated requests. Claude updates the prompt to specifically look for polite-but-frustrated language.

On the next iteration: nine out of 10. Good enough to ship.

We codify this entire workflow—from identifying patterns to iterating prompts to validation—in CLAUDE.md. The next time we need to detect a user's emotion or behavior, we don't start from scratch. We say: "Use the prompt workflow from the frustration detector." The system already knows what to do.

## From Personal Tool to Shared System

I created this for me. My codebase, my patterns, my preferences.

Then I showed it to Dan. He started using it at Every. Then we showed it to a few friends. Then we open-sourced it.

Now thousands of developers use it. They've added their own agents, their own patterns, their own workflows. The system compounds not just within a single codebase, but across the entire community.

The weird part? It works for them too. The core philosophy—each unit of work should make subsequent work easier—turns out to be universal. Different codebases, different languages, different problems. Same principle.

## The Results

In three months of compound engineering on Cora:

- **Time-to-ship** dropped from over a week per feature to 1-3 days
- **Bugs caught before production** increased substantially
- **PR review cycles** that used to drag on for days now finish in hours
- **My three-column workflow**: planning in one terminal, building in another, reviewing in a third

At Cora, we've used compound engineering to:

- **Transform production errors into permanent fixes** by having AI agents automatically investigate crashes, reproduce problems from system logs, and generate both the solution and tests to prevent recurrence
- **Extract architectural decisions from collaborative work sessions** by recording design discussions, then having Claude document why certain approaches were chosen
- **Build review agents with different expertise**—a "Kieran reviewer" that enforces my style choices, a "Rails expert reviewer" for framework best practices, a "performance reviewer" for speed optimization
- **Automate visual documentation** by deploying an agent that detects interface changes and captures before/after screenshots across different screen sizes and themes
- **Parallelize feedback resolution** by creating a dedicated agent for each piece of reviewer feedback that works simultaneously—ten issues resolved in the time it used to take for one

## What This Guide Is

This guide is everything I know about compound engineering.

It's the philosophy: why compound work matters, what beliefs you need to adopt, what beliefs you need to let go.

It's the practice: the stages of AI development, how to level up through them, the main workflow loop.

It's the tooling: the plugin, the agents, the commands, the skills.

And it's the guides: how to apply compound engineering to design, to product marketing, to team collaboration, to vibe coding.

I'm still learning. The system still compounds. But if you're reading this, you're ready to start your own compounding journey.

Let's go.
# Philosophy: The Compound Engineering Manifesto

> Each unit of engineering work should make subsequent units easier—not harder.

This is the core principle. Everything else flows from it.

Traditional development accumulates debt. Every feature adds complexity. Every shortcut creates future work. The codebase gets harder to understand, harder to modify, harder to trust. Ten years in, you're spending more time fighting the system than building on it.

Compound engineering inverts this. Every feature teaches the system. Every bug fix prevents future bugs. Every pattern you codify becomes a tool for future work. The codebase gets easier to understand, easier to modify, easier to trust.

The question isn't "how do I ship this feature?" It's "how do I ship this feature in a way that makes the next one easier?"

## The Beliefs You Need to Let Go

You've been trained to think a certain way about software development. Some of that training is now wrong. Here's what to unlearn:

### "I must write the code myself"

No. You must ensure good code gets written. Whether you type it or an AI types it is irrelevant. What matters is the outcome: clean, tested, maintainable code that solves the right problem.

### "I must review every line"

No. You must ensure the code meets your standards. That can mean reviewing every line. It can also mean having systems that catch what you'd catch, then trusting those systems.

If you don't trust the systems, make them better. Don't compensate by manual review forever.

### "I must come up with the solutions"

No. You must ensure good solutions get chosen. The AI can research approaches, analyze tradeoffs, and recommend options. Your job is taste: knowing which solution fits this codebase, this team, this context.

### "Code is the most important artifact"

No. The system that produces good code is the most important artifact. A single brilliant implementation is worth less than a process that consistently produces good implementations.

### "Writing code is the job"

No. Shipping value is the job. Code is one means. Planning is another. Reviewing is another. Teaching the system is another. The best compound engineers write less code than they used to—and ship more value.

## The Beliefs You Need to Adopt

### Extract your taste into the system

You have preferences. You know what good code looks like in this codebase. You have opinions about architecture, naming, error handling, testing.

Right now, that taste lives in your head. Every time the AI writes code, you impose your taste through review. This doesn't scale.

Extract it. Write it down. Turn it into agents, into prompts, into CLAUDE.md instructions. When the system shares your taste, it produces code you like without you having to fix it.

### Spend more time codifying, less time coding

Here's the 50/50 rule: spend 50% of your time improving the system, 50% building features.

Traditional engineering inverts this—90% building, 10% everything else. That's why traditional codebases accumulate debt.

When you invest in the system, you're not slowing down. You're building an asset that produces returns forever. An hour spent creating a review agent saves ten hours of review over the next year.

### The $100 Rule

When something fails that should have been prevented, I fine myself $100 and spend it on the permanent fix—a test, a rule, an eval.

Example: A user reported they never received their daily email Brief—a critical failure. We wrote tests that catch similar delivery lapses, updated monitoring rules to flag when Briefs aren't sent, and built evaluations that continuously verify the delivery pipeline.

Now the system always watches for this category of problem. What started as a failure made our tools permanently smarter.

The $100 rule creates a forcing function. Feel the sting once, fix it forever. Every failure becomes an investment in prevention.

### Spend more time planning, less time implementing

A good plan with mediocre execution beats a mediocre plan with brilliant execution.

Here's why: the AI can execute brilliantly. It writes code fast, it doesn't get tired, it doesn't make typos. What it can't do is know what to build. That's your job.

Invest in planning. Research thoroughly. Consider alternatives. Get the plan right. Then tell the AI to implement it and get out of the way.

### Trust the process, build safety nets

You can't scale AI assistance if you're reviewing every line. You need to trust the process.

But trust doesn't mean blind faith. It means building systems that catch problems. It means having tests that fail when things break. It means having review agents that flag issues.

If you don't trust a step, don't compensate by manual review. Instead, add a system that makes that step trustworthy. Then trust the system.

### Build for future models, not current limitations

Today's models have limitations. They make mistakes. They need guidance.

Don't build elaborate compensations for these limitations. Build systems that assume the models will improve.

What does this mean practically? Lean into agentic architectures over rigid workflows. Workflows break when the model changes. Agents adapt. Build for the model you'll have in six months, not the model you have today.

### Make your environment agent-native

If you can do something as a developer, the agent should be able to do it too. If you can see something, the agent should be able to see it too.

Can you run tests? The agent should be able to run tests.
Can you check production logs? The agent should be able to check production logs.
Can you debug with screenshots? The agent should be able to debug with screenshots.
Can you create pull requests? The agent should be able to create pull requests.

Every capability you withhold from the agent is a capability that requires your manual intervention. Agent-native architecture means the agent can do everything you can do.

### Make it your own

There is no universal compound engineering setup. There's your setup.

Your codebase is different. Your team is different. Your preferences are different. The system that works for you won't work identically for anyone else.

Experiment. Figure out what works. Adapt what you learn from others. But don't cargo-cult someone else's system. Build yours.

### Parallelization is your friend

The old constraint was human attention. You could only work on one thing at a time.

The new constraint is computer resources. You can run ten agents in parallel. You can have three features being developed simultaneously. You can review, test, and document at the same time.

Think parallel. When you're blocked on one thing, don't wait—start something else. Let the agents work while you plan the next thing.

**Mission Control Setup**

My monitor now looks like mission control:

- **Left lane: Planning.** A Claude instance reads issues, researches approaches, and writes detailed implementation plans.
- **Middle lane: Building.** Another Claude takes those plans and writes code, creates tests, and implements features.
- **Right lane: Reviewing.** A third Claude reviews the output against CLAUDE.md, suggests improvements, and catches issues.

It feels awkward at first—like juggling while learning to juggle—but within a week it becomes natural.

### Your job isn't to type code anymore

Your job is to design the systems that design the systems.

Companies are paying $400 per month for what used to cost $400,000 per year. One-person startups are competing with funded teams. AI is democratizing not just coding, but entire engineering systems. Leverage is shifting to those who teach these systems faster than they type.

If you are an engineer that types code, the value of typing code will actually go to zero very soon. Start focusing on the other parts—the taste, the vision, the systems—and become a compound engineer.

### Push compound thinking everywhere

Compound engineering isn't just for writing code. It applies to:

- **Research**: Document what you learn so you don't re-research later
- **Design**: Codify design patterns so AI can apply them
- **QA**: Build test systems that catch what you'd catch manually
- **Product marketing**: Generate announcements from code changes
- **Security**: Build review agents that catch vulnerabilities
- **Debugging**: Document solutions so the same bug never costs you twice
- **Postmortems**: Turn incidents into prevention systems

Everywhere you do repeated work, ask: how do I do this once and have the system do it forever?

## The Flywheel

Here's what happens when you follow these principles:

Your first code review is slow. You're teaching the agent what to look for.

Your second code review is faster. The agent remembers what you taught it.

Your tenth code review catches things you used to miss. The agent has learned patterns you didn't consciously know.

Your hundredth code review runs in parallel with five other reviews. You're reviewing the findings, not the code.

This is the flywheel. Each cycle makes the next one better. The work compounds.

## The Discomfort

This will feel uncomfortable.

You'll feel lazy when you're not typing code. You're not lazy—you're leveraging.

You'll feel out of control when the agent works autonomously. You're not out of control—you're trusting systems you built.

You'll feel guilty when a feature ships without you touching the implementation. Don't. You planned it, reviewed it, and ensured it met your standards. That's more valuable than typing it.

The discomfort is a signal. It means you're changing how you work. Push through it.

## The Compound Engineer's Oath

I will make each unit of work make subsequent work easier.

I will extract my taste into systems, not enforce it through manual review.

I will spend more time teaching the system than doing the work myself.

I will trust the process and build safety nets instead of compensating with manual review.

I will make my environment agent-native.

I will push compound thinking into every part of my work.

I will embrace the discomfort of letting go.

I will ship more value while typing less code.
# The AI Development Ladder

Not all AI-assisted development is the same. There's a ladder—a progression from basic chat assistance to fully autonomous engineering. Where you are on this ladder determines what compound engineering practices make sense for you.

You can't skip stages. Jumping from Stage 0 to Stage 5 is too extreme. It feels uncomfortable, and you won't trust the process. You need to climb the ladder one rung at a time.

## Stage 0: Not Using AI

This is where everyone started. You write every line. You research solutions by reading documentation and Stack Overflow. You debug by reading code and adding print statements.

There's nothing wrong with Stage 0. It's how great software was built for decades. But if you're still here in 2025, you're working harder than you need to.

**Characteristics:**
- Pure manual coding
- No AI assistance
- All research is human-driven
- Debugging is manual

**When this makes sense:**
- Learning a new language or framework (sometimes)
- Security-critical code where you need to understand every line
- When the AI genuinely can't help (rare these days)

## Stage 1: Chat-Based AI (Side-by-Side)

You're using ChatGPT, Claude, or Cursor as a helper. You ask questions, get snippets, copy-paste code. The AI is a smart reference book that can write code for you.

You're still in control. You're still reviewing everything. The AI accelerates research and boilerplate, but you're the one steering.

**Characteristics:**
- Asking AI for code snippets
- Copying and pasting into your editor
- Using AI to explain code or debug errors
- Reviewing every line the AI writes
- Still thinking of AI as a tool, not a collaborator

**What this feels like:**
"Can you write a function that does X?"
"What's wrong with this code?"
"How do I use library Y?"

**Benefits over Stage 0:**
- Faster boilerplate
- Instant answers to questions
- Better error messages explanation

**Limitations:**
- Lots of context switching (chat → editor → chat)
- No codebase awareness
- You're still doing all the integration work

## Stage 2: Agentic with Line-by-Line Review

You're using agentic tools—Claude Code, Cursor Composer, Copilot Chat. The AI can read your files, understand your codebase, and make changes directly.

But you're still reviewing everything. The agent proposes a change, you read every line, you approve or reject. You're the gatekeeper.

**Characteristics:**
- Agent has codebase access
- Agent can read and write files
- You approve every single action
- You review every line of changed code
- Step-by-step collaboration

**What this feels like:**
"Add a user authentication feature" → agent writes code → you review each file → approve → agent continues

**Benefits over Stage 1:**
- No context switching
- Agent understands your codebase
- Multi-file changes in one flow
- Agent maintains consistency

**Limitations:**
- Slow—you're reviewing everything
- Bottleneck is your attention
- Can't parallelize
- You're still doing all the quality assurance

**This is where most developers stop.** It feels productive. You're shipping faster than Stage 1. But you're leaving massive gains on the table.

## Stage 3: Plan and Review PR Only

This is the breakthrough stage.

You create a detailed plan with the AI. You nail down the requirements, the approach, the edge cases. Then you say "implement this" and walk away.

When you come back, there's a pull request. You review the PR, not every line change. You trust the plan and the process. If something's wrong, you fix it in the PR review—you don't babysit the implementation.

**Characteristics:**
- Thorough planning upfront
- "Implement this plan" as a single command
- Review happens at PR level, not line level
- Feels like working with a junior developer
- You can hand off plans to others, or pick up their plans

**What this feels like:**
You: "Here's the plan for user authentication: JWT tokens, refresh mechanism, password hashing with bcrypt, tests for all edge cases."
Agent: *implements for 10 minutes*
Agent: "PR ready for review."
You: *review the PR, request one change*
Agent: *fixes it*
You: *merge*

**Benefits over Stage 2:**
- 10x faster—you're not the bottleneck
- Can do other things while agent implements
- Better quality—thorough planning catches issues early
- Collaborative—others can implement your plans

**Limitations:**
- Still one thing at a time
- Still on your computer
- Still some manual review

**This is where compound engineering really starts.** Your plans get better because the agent learns your patterns. Your reviews get faster because you trust the process. The work compounds.

## Stage 4: Idea to PR (Single Computer)

You have an idea. You describe it. A pull request appears.

The agent does everything: researches the codebase, creates a plan, implements, runs tests, does a self-review, fixes issues, creates the PR. You just had the idea.

Still on your computer, still one thing at a time. But your involvement drops to: idea → review PR → merge.

**Characteristics:**
- End-to-end autonomous implementation
- Agent handles planning, implementation, testing, review
- You review the final PR only
- Feels like working with a competent colleague

**What this feels like:**
You: "Add email notifications when users get new comments."
*go for coffee*
Agent: "PR #247 ready. Added NotificationMailer, background job for async delivery, preference settings. Tests pass."
You: *review PR, looks good, merge*

**Benefits over Stage 3:**
- Near-zero implementation involvement
- Agent catches issues before you see them
- You focus on what to build, not how

**Limitations:**
- Still sequential
- Computer is busy while agent works
- Can't parallelize

## Stage 5: Parallel in the Cloud

The final stage. Work happens in the cloud, in parallel.

You describe three features. Three agents spin up, each implementing one. You check in periodically to review PRs. When one finishes, you give it another task.

At the extreme: the agent proactively monitors for feature requests, user feedback, bug reports. It proposes features, you approve, it implements. You're steering a fleet, not rowing a boat.

**Characteristics:**
- Cloud-based execution
- Multiple features in parallel
- Proactive—agent proposes what to build
- You're a reviewer and approver
- User feedback → features without you writing code

**What this feels like:**
Monday morning:
- PR #248: Email notifications *(from your idea)*
- PR #249: Dark mode *(from user feedback)*
- PR #250: Performance fix *(from monitoring)*

You: *review all three, merge two, request changes on one*
Agent: *fixes requested changes, proposes next features*

**Benefits over Stage 4:**
- True parallelization
- Proactive problem-solving
- Computer isn't tied up
- Scale beyond what one human could do

**Limitations:**
- Requires infrastructure
- Requires trust in the process
- Requires good systems to avoid chaos

## Where Are You?

Be honest. Most developers reading this are at Stage 1 or 2.

That's fine. The path is clear:

**From Stage 1**: Start using agentic tools. Let the AI access your codebase. Get comfortable with it making changes.

**From Stage 2**: Stop reviewing every line. Create better plans. Trust the process. Review at PR level.

**From Stage 3**: Reduce your involvement further. Let the agent handle more end-to-end. Get comfortable with not seeing every step.

**From Stage 4**: Move to cloud. Run things in parallel. Build systems for proactive work.

Each stage takes time. Each stage feels uncomfortable at first. That's how you know you're progressing.

## The Quiz

Here's a quick assessment:

**When the AI writes code, do you:**
- A) Copy-paste it into your editor and review it there → Stage 1
- B) Let it write directly but approve each step → Stage 2
- C) Let it implement a plan while you do something else → Stage 3
- D) Just describe what you want and review the PR → Stage 4
- E) Have multiple things being implemented in parallel → Stage 5

**When you find a bug, do you:**
- A) Debug it yourself → Stage 0/1
- B) Ask the AI for help, then implement the fix → Stage 1/2
- C) Create a plan for the fix and have the agent implement → Stage 3
- D) Describe the bug and let the agent handle everything → Stage 4
- E) Have agents monitoring for bugs and fixing them automatically → Stage 5

**When you want a new feature, do you:**
- A) Write all the code yourself → Stage 0
- B) Ask the AI to write parts of it → Stage 1
- C) Collaborate step-by-step with the agent → Stage 2
- D) Create a detailed plan and say "implement" → Stage 3
- E) Describe the feature and review the PR → Stage 4
- F) Have agents proposing features from user feedback → Stage 5

Find your lowest score. That's your current stage. The next chapter tells you how to level up.
# How to Level Up

Each stage on the AI development ladder requires a different approach. Here's how to climb from wherever you are.

## Level 0 → Level 1: Start Collaborating

You've never really used AI for coding. You've heard about it, maybe tried ChatGPT for a few questions, but your workflow is still: you + your editor + documentation.

### What to do:

1. **Pick one tool.** Cursor with Opus 4.5 is a good start. Or Claude Code if you prefer terminal. Or GitHub Copilot if you want minimal setup.

2. **Start with questions, not code.** Ask the AI to explain code you're looking at. Ask it why something isn't working. Get comfortable talking to it.

3. **Let it write boilerplate.** The first code you let AI write should be boring: tests, config files, repetitive functions. Low stakes, high time savings.

4. **Always review what it writes.** Copy-paste into your editor. Read every line. Fix what's wrong. You're learning what it gets right and wrong.

### What you'll experience:

- Amazement at how fast it writes code
- Frustration when it gets things wrong
- Uncertainty about whether to trust it
- Gradually increasing trust as you learn its patterns

### How to compound:

After each session, note what the AI got wrong. These become the things you check for in future reviews. You're building a mental model of AI behavior.

### When you're ready to move on:

You're using AI daily. You trust it for some things. You have a sense of what it's good at. You're ready to let it work more directly in your codebase.

---

## Level 1 → Level 2: Let the Agent In

You're comfortable chatting with AI, but you're still copy-pasting code. It's time to let the agent access your codebase directly.

### What to do:

1. **Switch to an agentic tool.** Claude Code, Cursor Composer, or similar. Something that can read and write your files.

2. **Start small.** "Add a test for this function." "Fix the linting error in this file." Let the agent make targeted changes you can easily verify.

3. **Approve each action.** The agent will ask permission before making changes. Say yes when it's right, no when it's wrong. You're still the gatekeeper.

4. **Review the diffs, not just the code.** Look at what changed, not just what's there. The agent should explain what it's doing.

### What you'll experience:

- Relief at not context-switching constantly
- Anxiety about letting something modify your files
- Occasional "what did it just do?" moments
- Gradual comfort with the agent's changes

### How to compound:

Add context to your project. Create a CLAUDE.md with your preferences. When the agent makes a mistake, add a note about what to avoid. The agent gets smarter with each piece of context.

### When you're ready to move on:

You're not worried about the agent making changes. You trust the diffs. You're spending more time reviewing than typing. The bottleneck is your attention, not the AI's capability.

---

## Level 2 → Level 3: Trust the Plan

You're collaborating step-by-step, but it's slow. You approve every action. Time to graduate to plan-level trust.

### What to do:

1. **Invest in planning.** Before you start implementing, create a thorough plan. What are the requirements? What's the approach? What edge cases exist?

2. **Have the agent research.** Let it read your codebase, understand the patterns, suggest approaches. Use its research to inform your plan.

3. **Make the plan explicit.** Write it down. Be specific. The more detail in the plan, the less you need to supervise implementation.

4. **Say "implement this" and walk away.** Give the agent the plan and let it work. Come back when it's done.

5. **Review at PR level.** Look at the final result, not every step. Does it match the plan? Does it work? Is it clean?

### What you'll experience:

- Anxiety about not watching every step
- Surprise at how much gets done while you're away
- Occasional "that's not what I meant" moments
- Realization that better plans = better results

### How to compound:

After each implementation, note what the plan was missing. What did the agent interpret incorrectly? What should you have specified? Better plans compound into better results.

### What's different at Stage 3:

You're not babysitting. You're directing. The agent is a collaborator who can execute independently. You can do other things while it implements.

### When you're ready to move on:

You're comfortable not watching implementation. Your plans are detailed enough that results match expectations. You're thinking about what else could be automated.

---

## Level 3 → Level 4: Describe, Don't Plan

You're good at planning, but planning still takes your time. Time to trust the agent with planning too.

### What to do:

1. **Give high-level descriptions.** Instead of detailed plans, describe what you want. "Add email notifications for new comments." Let the agent figure out the how.

2. **Trust the agent to research.** It knows your codebase. It can find similar implementations. It can read documentation. Let it do the planning work.

3. **Review the plan before implementation.** The agent should show you its plan. You approve the approach, not the details.

4. **Review the PR, not the process.** When implementation is done, look at the result. The agent self-reviews and fixes issues before showing you.

### What you'll experience:

- Surprise at how good the agent's plans are
- Occasional course corrections on approach
- Realization that you're a reviewer, not an implementer
- Freedom to focus on higher-level thinking

### How to compound:

Document patterns the agent should follow. When it makes good decisions, note why. When it makes bad ones, add guidance. The agent's judgment improves with each codified pattern.

### What's different at Stage 4:

You're not planning. You're ideating. The agent handles everything from idea to PR. Your job is to have good ideas and verify good results.

### When you're ready to move on:

You trust the agent's end-to-end process. You have good systems for quality (tests, reviews, monitoring). You want to scale beyond one thing at a time.

---

## Level 4 → Level 5: Parallelize Everything

You've got one agent doing great work. Time to have many.

### What to do:

1. **Move to cloud execution.** The agent shouldn't tie up your computer. Use cloud-based Claude instances, GitHub Actions, or dedicated infrastructure.

2. **Start multiple work streams.** Three features in parallel. One agent per feature. Review PRs as they come in.

3. **Build a queue system.** Ideas, bugs, and improvements go into a queue. Agents pull work. You review results.

4. **Make it proactive.** Agents monitor for opportunities. User feedback becomes feature proposals. Errors become bug fixes. You approve, they implement.

### What you'll experience:

- Overwhelm at first from parallel work streams
- Need for better systems (PR queues, notifications, priorities)
- Excitement at shipping velocity
- Shift in identity from implementer to orchestrator

### How to compound:

Every system you build to manage parallel work makes parallel work easier. Better PR templates. Better notification systems. Better prioritization rules. The infrastructure compounds.

### What's different at Stage 5:

You're running a fleet. Your job is strategy—what should we build, in what order, to what standard? The agents handle execution.

---

## Common Pitfalls

### Trying to skip stages

Don't go from Stage 1 to Stage 4. You haven't built the trust, the systems, or the intuition. You'll revert when something goes wrong.

### Staying stuck at Stage 2

Stage 2 feels productive. You're shipping faster than before. But you're leaving 90% of the gains on the table. Push through the discomfort.

### Compensating instead of compounding

When something goes wrong, don't just fix it—prevent it. Don't review more carefully; build systems that catch issues automatically.

### Blaming the tool when you should improve the plan

Bad results usually mean bad inputs. If the agent keeps getting things wrong, your plans aren't detailed enough. Your context isn't clear enough. Improve the inputs.

---

## The Two Paths

There are two valid paths through the ladder:

### The Engineer's Path

For experienced engineers who want to understand every step:
- Progress slowly through each stage
- Build deep understanding of what the agent can and can't do
- Create sophisticated compound systems
- Eventually reach Stage 5 with full confidence

### The Vibe Coder's Path

For people who just want results:
- Jump to Stage 4 as fast as possible
- Use default settings and don't worry about details
- Accept some mistakes in exchange for speed
- Perfect for personal projects, prototypes, experiments

Both paths are valid. Know which one you're on.

---

## Your Next Step

Find your current stage. Then do one thing:

**Stage 0**: Install Claude Code or Cursor. Ask it one question about your codebase.

**Stage 1**: Let the agent make a change directly in your files. Something small. Review the diff.

**Stage 2**: Create a detailed plan for a small feature. Say "implement this" and don't touch the keyboard until it's done.

**Stage 3**: Describe a feature in one sentence. Let the agent plan and implement. Review only the PR.

**Stage 4**: Set up cloud execution. Start two features in parallel.

One step. That's all it takes to start climbing.

---

## The 30/60/90 Day Transformation

Here's a concrete timeline for making compound engineering work.

### First 30 Days: Building the Foundation

Start with one lane. Pick building—it's the most familiar.

**What to do:**
1. Set up your first git worktree (`git worktree add ../project-build`)
2. Create a CLAUDE.md with your five strongest opinions about code. Maybe it's "No magic numbers" or "Every function needs a docstring." Whatever rules you find yourself repeating in code reviews.
3. Wait for something to break. It won't take long.
4. When it breaks, apply the $100 rule: fine yourself and spend it on the permanent fix.

By day 30, you'll have a small but growing system that knows your preferences.

### Days 31-60: Expanding the System

Now add your second lane—review.

**What to do:**
1. Build a simple eval harness (even a bash script that runs test cases)
2. Start documenting architectural principles in llms.txt
3. Create specialized review commands that check for your common anti-patterns
4. Start measuring your compound rate—the week-over-week improvement in velocity

This is when the compound effect becomes visible. Features that took a week now take days. Your review agent catches issues you used to spend hours finding.

### Days 61-90: Full Orchestration

All three lanes running.

**What to achieve:**
- Context documents that update themselves on merge
- An eval suite that catches regressions before they hit production
- Moving at 5x your original pace
- The system getting smarter without you

At this point, you've built a development environment that learns from every PR, every bug, every decision. That's compound engineering.

### The Exponential Curve

- **Week 1**: You teach Claude your codebase
- **Week 4**: Claude is catching your style violations
- **Week 8**: Claude is suggesting architectural improvements
- **Week 12**: Claude is building features you haven't imagined yet

Each improvement multiplies the next. That's the compounding curve.
# The Main Loop

At the heart of compound engineering is a four-step loop:

```
Plan → Work → Review → Compound → Repeat
```

These four steps are composable. Each one can be expanded or contracted depending on what you're building. But if you're doing compound engineering at Stage 3 or above, you're running some version of this loop for every meaningful piece of work.

The 80/20 rule applies: 80% of your time is in Plan and Review. 20% is in Work and Compound. Most of the thinking happens before and after the code gets written.

---

## 1. PLAN

The plan phase turns an idea into a blueprint. The better the plan, the better the result.

### What happens in Plan:

1. **Understand the requirement.** What are we building? Why? What constraints exist?

2. **Research the codebase.** How does similar functionality work? What patterns exist? What would need to change?

3. **Research externally.** What do the framework docs say? What are best practices? How have others solved this?

4. **Design the solution.** What's the approach? What files need to change? What are the edge cases?

5. **Validate the plan.** Does this make sense? Is it complete? Are there gaps?

### Plan fidelities:

Not all plans need the same depth:

**Small (Quick tasks):**
- Bug fixes with known cause
- Straightforward additions
- Single-file changes
- Minimal research, fast execution

**Medium (Standard features):**
- New functionality
- Multi-file changes
- Moderate research
- Clear but detailed plan

**Large (Complex features):**
- Architectural changes
- Multiple research agents working in parallel
- Framework docs, best practices, repo analysis, git history
- Detailed plan with edge cases and rollback strategy

The `/plan` command detects which fidelity you need and resources accordingly.

### Plan variations:

**Ultra-think mode:** For complex plans, enable deep thinking. The agent spends more time considering alternatives and edge cases. Automatically runs `/deepen-plan` afterward for more research.

**Fast mode:** For simple changes, skip the research. Ground in the codebase and generate a plan quickly. Good for urgent fixes.

### Research Tactics

Each tactic serves a different purpose. Use multiple tactics for bigger features:

**Grounding in Best Practices:**
Search the internet for best practices for this business use case or design pattern. Find blog posts, documentation, opinionated takes. More useful than generic model knowledge because it surfaces real-world opinions.

**Grounding in Your Codebase:**
Look through your current source code to see if you already do anything similar. Prevents reinventing the wheel. If you want to add event tracking and already have an event tracking system, the agent finds it instead of building a new one.

**Grounding in Libraries:**
Look through the source code of gems/packages you've installed. Better than reading documentation because you know exactly what's available. When you update a package, the agent automatically knows the new capabilities.

**Git History:**
Look at past commits in relevant files to understand the direction and intention. Especially useful for refactoring—you can see what was removed, what was added, why changes were made.

**Vibe Coding for Prototypes:**
Sometimes you don't know what you want to build. Vibe code a prototype first—let the AI generate options, iterate quickly, see what works. Then take that understanding and create a proper plan. Delete the prototype, start fresh with knowledge.

### The agents that help with planning:

- **framework-docs-researcher**: Finds official documentation and patterns
- **best-practices-researcher**: Gathers industry standards and community examples
- **repo-research-analyst**: Analyzes your codebase structure and conventions
- **git-history-analyzer**: Understands how code has evolved and why

### A good plan includes:

- **Context**: Why are we doing this? What problem does it solve?
- **Approach**: How will we solve it? What's the strategy?
- **Files**: What needs to change? What needs to be created?
- **Edge cases**: What could go wrong? How do we handle it?
- **Tests**: What tests will validate this works?
- **Rollback**: If this breaks, how do we revert?

---

## 2. WORK

The work phase executes the plan. In compound engineering, you're not typing—you're monitoring.

### What happens in Work:

1. **Set up isolation.** Worktrees or branches to keep work separate.

2. **Execute the plan.** The agent implements step by step.

3. **Run validations.** Tests, linting, type checking.

4. **Track progress.** What's done, what's remaining.

5. **Handle issues.** When something goes wrong, adapt.

### Work in practice:

You say `/work` with a plan. The agent:
- Creates a worktree
- Implements each step of the plan
- Runs tests after significant changes
- Creates a PR when done

You're not watching every line. You're trusting the plan. If the plan was good, the execution will be good.

### When to intervene:

- Tests are failing repeatedly
- The agent is clearly stuck
- Something fundamental was wrong in the plan

When you intervene, update the plan, not the code. Let the agent fix the code based on the updated plan.

### Parallel work:

At Stage 4+, you can have multiple work streams:
- Feature A in worktree A
- Feature B in worktree B
- Bug fix in worktree C

Check in periodically. Review PRs as they complete.

---

## 3. REVIEW (Assess)

The review phase catches issues before they ship. But more importantly, it captures learnings for the next cycle.

### What happens in Review:

1. **Multi-agent review.** Multiple specialized reviewers examine the code in parallel.

2. **Prioritize findings.** P1 (must fix), P2 (should fix), P3 (nice to fix).

3. **Resolve findings.** The agent fixes issues based on review feedback.

4. **Validate fixes.** Ensure fixes are correct and complete.

5. **Capture patterns.** Note what went wrong so it doesn't happen again.

### The review agents:

Run `/review` and watch twelve agents analyze your code in parallel:

**Security:**
- **security-sentinel**: OWASP top 10, injection attacks, auth flaws

**Performance:**
- **performance-oracle**: N+1 queries, caching opportunities, bottlenecks

**Architecture:**
- **architecture-strategist**: System design, component boundaries, patterns
- **pattern-recognition-specialist**: Design patterns, anti-patterns, code smells

**Data:**
- **data-integrity-guardian**: Migrations, transactions, referential integrity
- **data-migration-expert**: ID mappings, rollback safety, production validation

**Quality:**
- **code-simplicity-reviewer**: YAGNI, unnecessary complexity, readability
- **kieran-rails-reviewer**: Rails conventions, Turbo Streams, fat models
- **kieran-python-reviewer**: PEP 8, type hints, Pythonic patterns
- **kieran-typescript-reviewer**: Type safety, modern patterns, clean architecture
- **dhh-rails-reviewer**: 37signals style, simplicity over abstraction

**Deployment:**
- **deployment-verification-agent**: Pre/post-deploy checklists, rollback plans

### Review output:

You get a prioritized list:

```
P1 - CRITICAL (Must Fix):
[ ] SQL injection vulnerability in search query (security-sentinel)
[ ] Missing transaction around user creation (data-integrity-guardian)

P2 - IMPORTANT (Should Fix):
[ ] N+1 query in comments loading (performance-oracle)
[ ] Controller doing business logic (kieran-rails-reviewer)

P3 - MINOR (Nice to Fix):
[ ] Unused variable (code-simplicity-reviewer)
[ ] Could use guard clause (pattern-recognition-specialist)
```

### Resolve in parallel:

Run `/resolve_pr_parallel` and the agent fixes all findings simultaneously. P1s first, then P2s. Review the fixes.

### Three Questions When You Don't Have Tooling

Not everyone has thirteen review agents. The principle still works. Before you approve any AI output, ask three questions:

1. **"What was the hardest decision you made here?"**
2. **"What alternatives did you reject, and why?"**
3. **"What are you least confident about?"**

That two-minute conversation surfaces what a ten-minute read would have missed. The AI knows where the tricky parts are. It just doesn't volunteer them unless you ask.

### The compounding effect:

Each review teaches the system. After fifty reviews, the agents know your patterns. They catch issues you didn't even know you cared about, because they learned your preferences from your feedback.

During one signature fix, I rejected a finding that suggested extracting HTML methods into a service. "Not yet," I said. "These four methods are only used here. Extract when we need them elsewhere." The system learned my threshold. Next PR, it didn't flag similar private method clusters.

The question isn't "did I catch every error?" It's "did I teach the system what good looks like?"

---

## 4. COMPOUND

The compound phase is where the magic happens. You turn this cycle's learnings into next cycle's advantages.

### What happens in Compound:

1. **Capture the solution.** What did we learn? What worked? What didn't?

2. **Make it findable.** Add YAML frontmatter, tags, categories.

3. **Update the system.** New patterns in CLAUDE.md. New agents if needed.

4. **Verify the learning.** Would the system catch this next time?

### Compound in practice:

You just fixed a tricky CORS issue. Instead of moving on:

```
/compound
```

The agent:
- Asks you what the issue was
- Documents the solution
- Tags it for searchability
- Adds it to your docs

Next time someone (or some agent) searches "CORS production", they find your solution in five seconds instead of debugging for three hours.

### What to compound:

- **Bug fixes**: Especially ones that took time to diagnose
- **Patterns**: Solutions that could apply elsewhere
- **Mistakes**: Things to avoid next time
- **Preferences**: Choices you made about approach

### The compound-docs skill:

Use `skill: compound-docs` to create structured documentation:

```yaml
---
title: "CORS Issue with Cross-Origin Credentials"
category: debugging
tags: [cors, production, nginx]
created: 2025-01-15
---

## Problem
Requests to /api/auth failing with CORS errors in production only...

## Solution
Add `credentials: include` to fetch requests and configure nginx...

## Prevention
Always test with production CORS settings in staging...
```

---

## The Full Loop in Action

Here's what a full cycle looks like:

### Day 1: Plan
**Input:** "Add comment notifications for blog posts"

Run `/plan`. The agent:
- Researches your notification patterns (repo-research-analyst)
- Checks Rails notification best practices (framework-docs-researcher)
- Analyzes your mailer setup (git-history-analyzer)
- Creates a detailed plan

You review the plan, tweak a few things, approve it.

### Day 1-2: Work
Run `/work`. The agent:
- Creates a worktree
- Implements CommentNotificationMailer
- Adds background job for async delivery
- Creates user preferences for notifications
- Writes tests
- Opens a PR

### Day 2: Review
Run `/review`. Twelve agents analyze the PR:
- security-sentinel: Looks good
- performance-oracle: Flag - potential N+1 on comment loading
- kieran-rails-reviewer: Flag - mailer should use deliver_later
- data-integrity-guardian: Looks good

Run `/resolve_pr_parallel`. The agent fixes both flags.

### Day 2: Compound
Run `/compound`. You note:
- "Always use deliver_later for mailers"
- "Comment queries need includes(:author)"

These get added to your compound docs. Next time, the review agents will remember.

### Day 3: Repeat
On to the next feature. The agents are slightly smarter. The plans are slightly better. The reviews catch slightly more.

This is the flywheel.

---

## Advanced: /LFG

When you're ready for full autonomy, there's one command that runs the entire loop:

```
/lfg "Add comment notifications"
```

The agent:
1. Creates a plan (with research)
2. You approve the plan
3. Implements the plan
4. Self-reviews and fixes issues
5. Runs your review agents
6. Fixes any findings
7. Compounds learnings
8. Creates the PR

You ideate. It executes. You review the final result.

This is Stage 4-5 compound engineering: idea to PR, automatically.

---

## Variations and Customization

### Deepening the plan:
```
/deepen-plan
```
Runs additional research, adds more detail, considers more edge cases.

### Fast planning:
"Create a quick plan, skip research, just ground in the codebase"

### Ultra-think mode:
Enable extended thinking for complex problems. The agent considers alternatives more thoroughly.

### Browser testing:
```
/test-browser
```
Runs Playwright tests against your changes. Validates what users actually see.

### Triage mode:
```
/triage
```
Interactive prioritization of review findings. You decide what matters.

The loop is flexible. Adapt it to your needs.
# The Plugin

Everything in this guide is codified in a Claude Code plugin. You don't have to build your own compound engineering system from scratch. You can use mine.

The plugin is open source. You can use it as-is, customize it, or just use it for inspiration to build your own.

## What's in the Box

**27 specialized agents.** Each one trained for a specific job. Security reviews, Rails conventions, performance analysis, architecture assessment.

**23 workflow commands.** The main loop (`/plan`, `/work`, `/review`, `/compound`) plus utilities for everything else.

**14 intelligent skills.** Domain expertise on tap. DHH-style Rails patterns. Gemini image generation. Andrew Kane gem patterns.

**2 MCP servers.** Playwright for browser automation. Context7 for framework documentation.

## Installation

Three commands:

```bash
# Add the marketplace
claude /plugin marketplace add https://github.com/EveryInc/every-marketplace

# Install the plugin
claude /plugin install compound-engineering

# Start using it
/plan "Add user authentication"
```

That's it. Zero configuration.

## Where It Works

The plugin is designed for Claude Code, but it works in:

- **Claude Code** (primary, what I use)
- **Cursor** (via Claude integration)
- **Droid from Factory** (for mobile)
- **Any IDE with Claude integration**

The agents and commands are just markdown files. They work wherever Claude works.

## The Agents

### Review Agents (14)

These are your code reviewers. Each one specializes in something different.

| Agent | What It Does |
|-------|--------------|
| kieran-rails-reviewer | Rails conventions with taste. Turbo Streams, namespacing, fat models. |
| dhh-rails-reviewer | 37signals style. Simplicity. No over-engineering. |
| kieran-python-reviewer | PEP 8, type hints, Pythonic patterns. |
| kieran-typescript-reviewer | Type safety, modern patterns, clean architecture. |
| security-sentinel | OWASP top 10, injection attacks, auth vulnerabilities. |
| performance-oracle | N+1 queries, caching, bottleneck identification. |
| architecture-strategist | System design patterns, component boundaries. |
| data-integrity-guardian | Migrations, transactions, referential integrity. |
| data-migration-expert | ID mappings, rollback safety, production validation. |
| deployment-verification-agent | Pre/post-deploy checklists, rollback plans. |
| pattern-recognition-specialist | Design patterns, anti-patterns, code smells. |
| code-simplicity-reviewer | YAGNI, unnecessary complexity, readability. |
| agent-native-reviewer | Ensures features are accessible to agents, not just humans. |
| julik-frontend-races-reviewer | JavaScript race conditions, DOM event handling. |

Run one directly:
```
claude agent security-sentinel "Review this pull request"
```

Or run them all via `/review`.

### Research Agents (4)

These gather context before you plan or implement.

| Agent | What It Does |
|-------|--------------|
| framework-docs-researcher | Finds official documentation and patterns. |
| best-practices-researcher | Gathers industry standards and community examples. |
| repo-research-analyst | Analyzes your codebase structure and conventions. |
| git-history-analyzer | Understands how code has evolved and why. |

They run automatically during `/plan`. You can also invoke them directly when you need research.

### Design Agents (3)

For when you're building UIs.

| Agent | What It Does |
|-------|--------------|
| design-iterator | Iterative UI refinement with screenshots. |
| figma-design-sync | Pixel-perfect matching between Figma and code. |
| design-implementation-reviewer | Catches visual regressions. |

### Workflow Agents (5)

For everything else.

| Agent | What It Does |
|-------|--------------|
| bug-reproduction-validator | Creates minimal reproductions. |
| pr-comment-resolver | Addresses PR feedback in batch. |
| lint | Code quality checks. |
| spec-flow-analyzer | User flow analysis and gap identification. |
| every-style-editor | Content editing for Every's style guide. |

### Documentation Agent (1)

| Agent | What It Does |
|-------|--------------|
| ankane-readme-writer | Clean, concise READMEs following Andrew Kane's style. |

## The Skills

Skills are domain expertise the agent can tap into when needed.

### Development Skills

| Skill | What It Does |
|-------|--------------|
| andrew-kane-gem-writer | Write Ruby gems like Andrew Kane. Clean APIs, smart defaults. |
| dhh-rails-style | Write Rails code like DHH. REST purity, Hotwire patterns. |
| dspy-ruby | Build type-safe LLM applications with DSPy.rb. |
| frontend-design | Production-grade frontend interfaces. |
| create-agent-skills | Build new skills with best practices. |
| skill-creator | Guide for creating effective skills with proper structure. |
| agent-native-architecture | Build applications where agents are first-class citizens. |

### Workflow Skills

| Skill | What It Does |
|-------|--------------|
| compound-docs | Capture solutions as searchable documentation. |
| file-todos | File-based todo tracking with priorities. |
| git-worktree | Manage worktrees for parallel development. |
| every-style-editor | Edit content for Every's style guide. |
| agent-browser | Browser automation via CLI for web interactions. |
| rclone | Upload and sync files to cloud storage providers. |

### Image Generation

| Skill | What It Does |
|-------|--------------|
| gemini-imagegen | Generate and edit images via Google's Gemini API. |

Requires `GEMINI_API_KEY` environment variable.

## The MCP Servers

MCP servers extend what Claude can do.

### Playwright

Browser automation. Claude can:
- Navigate to URLs
- Take screenshots
- Click elements
- Fill forms
- Execute JavaScript

Use case: Testing what users actually see. Catching visual bugs. Automating browser flows.

### Context7

Real-time documentation access. Claude can:
- Look up framework documentation
- Get current API references
- Find code examples

Use case: Getting accurate, up-to-date information instead of relying on training data.

**Note:** MCP servers currently need manual setup in `.claude/settings.json`. See the README for configuration.

## Customization

The plugin is a starting point. You should customize it.

### Adding agents

Create a markdown file in `agents/`:

```markdown
# My Custom Reviewer

You are a code reviewer specializing in [your domain].

## When to use this agent
[Description]

## How to review
[Instructions]
```

### Adding commands

Create a markdown file in `commands/`:

```markdown
# /my-command

## What this does
[Description]

## Instructions
[What the agent should do when this command runs]
```

### Adding skills

Create a directory in `skills/` with a SKILL.md:

```markdown
---
name: my-skill
description: What this skill does
---

# My Skill

[Instructions for when this skill is invoked]
```

### Updating CLAUDE.md

Add project-specific context:

```markdown
## Code Review Standards

Always check for:
- [ ] No business logic in controllers
- [ ] Tests for edge cases
- [ ] No N+1 queries
```

## The Philosophy in Practice

The plugin isn't just tools. It's the philosophy codified:

**Extract your taste:** The review agents encode my preferences. Customize them to encode yours.

**Spend time codifying:** Adding an agent takes an hour. It saves hundreds of hours of review.

**Trust the process:** Twelve agents reviewing in parallel catches more than you ever would.

**Make it your own:** Fork it, customize it, make it yours.

The plugin compounds. Every agent you add makes future work easier. Every pattern you codify prevents future bugs. Every skill you create saves future time.

That's the point.

## Getting Started

1. Install the plugin
2. Run `/plan` on your next feature
3. Run `/review` on your next PR
4. Notice what it catches that you might have missed
5. Add that to your review checklist

Small steps. The system compounds. In six months, you'll wonder how you worked without it.
# Slash Commands Reference

The plugin includes 23 slash commands. This chapter covers each one in detail.

## Core Workflow Commands

These are the main loop commands you'll use constantly.

---

### /plan

**Purpose:** Transform a feature idea into a detailed implementation plan.

**When to use:** At the start of any non-trivial work. Features, refactors, bug fixes that need investigation.

**What it does:**
1. Analyzes your request to determine fidelity (small/medium/large)
2. Researches your codebase via repo-research-analyst
3. Gathers framework documentation via framework-docs-researcher
4. Finds best practices via best-practices-researcher
5. Analyzes git history for context via git-history-analyzer
6. Creates a detailed plan with files, approach, edge cases

**Example:**
```
/plan Add email notifications when users receive new comments
```

**Output:** A structured plan document with:
- Context and requirements
- Proposed approach
- Files to modify/create
- Edge cases to handle
- Test strategy
- Rollback plan

**Variations:**

- **Ultra-think mode:** For complex plans, add "use ultra-think" or "think deeply". The agent considers more alternatives and automatically runs `/deepen-plan`.

- **Fast mode:** For simple changes, add "quick" or "fast". Skips external research, grounds only in codebase.

**Tips:**
- The more context you provide, the better the plan
- Review the plan before moving to `/work`
- Plans can be handed off to other developers

---

### /work

**Purpose:** Execute a plan with worktrees and task tracking.

**When to use:** After you have an approved plan.

**What it does:**
1. Creates an isolated worktree for the work
2. Implements the plan step by step
3. Runs validations (tests, linting) after changes
4. Tracks progress and handles issues
5. Creates a PR when done

**Example:**
```
/work
```
(With an active plan in context)

Or with a plan:
```
/work "Implement the email notification plan"
```

**Output:** A pull request with the implementation.

**Tips:**
- You don't need to watch every step
- Check in periodically to see progress
- If something goes wrong, update the plan, not the code

---

### /review

**Purpose:** Run exhaustive multi-agent code review.

**When to use:** Before merging any PR. Especially before production deployments.

**What it does:**
1. Launches 12+ specialized agents in parallel
2. Each agent analyzes the code from their perspective
3. Findings are collected and prioritized (P1/P2/P3)
4. Results are presented as actionable todos

**Example:**
```
/review PR#123
```

Or for the current changes:
```
/review
```

**Output:** Prioritized findings:
```
P1 - CRITICAL (Must Fix):
[ ] Security: SQL injection in search query
[ ] Data: Missing transaction around user creation

P2 - IMPORTANT (Should Fix):
[ ] Performance: N+1 query in comments loading
[ ] Style: Controller doing business logic

P3 - MINOR (Nice to Fix):
[ ] Quality: Unused variable
[ ] Style: Could use guard clause
```

**The agents involved:**
- security-sentinel
- performance-oracle
- architecture-strategist
- data-integrity-guardian
- pattern-recognition-specialist
- code-simplicity-reviewer
- kieran-rails-reviewer (or appropriate language reviewer)
- deployment-verification-agent
- And more depending on your configuration

**Tips:**
- Don't skip the review, even for small changes
- P1s are non-negotiable; fix them before merge
- Use `/resolve_pr_parallel` to fix findings automatically

---

### /compound

**Purpose:** Document solved problems to compound team knowledge.

**When to use:** Right after solving any non-trivial problem. Especially bugs that took time to diagnose.

**What it does:**
1. Asks you about what you solved
2. Creates searchable documentation with YAML frontmatter
3. Tags it for future findability
4. Adds to your compound docs collection

**Example:**
```
/compound
```

Then describe what you learned: "Figured out that CORS errors in production were caused by missing credentials:include in fetch requests, and nginx needed specific headers configured."

**Output:** A markdown document in your docs:
```yaml
---
title: "CORS Issues with Cross-Origin Credentials"
category: debugging
tags: [cors, production, nginx, fetch]
created: 2025-01-15
---

## Problem
Requests to /api/auth failing with CORS errors in production only...

## Root Cause
The fetch requests weren't including credentials, and nginx wasn't configured...

## Solution
1. Add credentials: include to all API fetch calls
2. Configure nginx with proper CORS headers...

## Prevention
Always test with production CORS settings in staging...
```

**Tips:**
- Compound immediately after solving, while it's fresh
- Include the problem, root cause, solution, and prevention
- Future you (or future agents) will thank you

---

### /lfg

**Purpose:** Full autonomous workflow—idea to PR.

**When to use:** When you're ready for Stage 4 compound engineering. You describe what you want, the agent does everything.

**What it does:**
1. Creates a plan (with research)
2. Shows you the plan for approval
3. Implements the plan
4. Self-reviews and fixes issues
5. Runs full `/review`
6. Fixes any findings
7. Compounds learnings
8. Creates the PR

**Example:**
```
/lfg Add dark mode toggle to settings page
```

**Output:** A complete PR with all reviews passed, findings fixed, and learnings documented.

**Tips:**
- Start with smaller features until you trust the process
- The plan approval step is your safety net
- Still review the final PR before merging

---

## Resolution Commands

These commands fix issues identified during review.

---

### /resolve_parallel

**Purpose:** Fix all TODO comments in the codebase in parallel.

**When to use:** After `/review` identifies issues, or when you have accumulated TODO comments.

**What it does:**
1. Finds all TODO comments
2. Launches parallel agents to fix each one
3. Validates fixes
4. Reports completion

---

### /resolve_pr_parallel

**Purpose:** Address all PR review comments in parallel.

**When to use:** After `/review` generates findings, or when you have GitHub PR comments to address.

**What it does:**
1. Reads all PR comments/findings
2. Prioritizes (P1 first, then P2, then P3)
3. Fixes each issue in parallel where possible
4. Validates fixes

---

### /resolve_todo_parallel

**Purpose:** Resolve all file-based todos in the todo tracking system.

**When to use:** When using the file-todos skill for task management.

---

## Utility Commands

---

### /changelog

**Purpose:** Generate engaging changelogs from recent merges.

**When to use:** Before releases, or regularly to keep stakeholders informed.

**Example:**
```
/changelog
```

---

### /triage

**Purpose:** Interactively prioritize and categorize issues.

**When to use:** When review findings need human judgment about priority, or when backlog needs organization.

---

### /reproduce-bug

**Purpose:** Investigate bugs using logs, console output, and browser screenshots.

**When to use:** When you have a bug report and need to verify/understand it.

**What it does:**
1. Reads available logs
2. Uses Playwright to capture the bug
3. Analyzes the reproduction
4. Suggests fixes

---

### /test-browser

**Purpose:** Run Playwright browser tests on pages affected by current changes.

**When to use:** After making frontend changes, before merging.

---

### /plan_review

**Purpose:** Have multiple agents review a plan before implementation.

**When to use:** For high-stakes plans where you want multiple perspectives before committing.

---

### /deepen-plan

**Purpose:** Enhance an existing plan with additional research and detail.

**When to use:** When a plan feels too shallow, or for complex features that need more investigation.

**What it does:**
1. Takes your existing plan
2. Launches additional research agents
3. Adds depth, best practices, and implementation details
4. Returns an enhanced plan

---

### /create-agent-skill

**Purpose:** Create or edit Claude Code skills with expert guidance.

**When to use:** When you want to add new capabilities to the plugin.

---

### /generate_command

**Purpose:** Create new slash commands following conventions.

**When to use:** When you want to automate a new workflow.

---

### /heal-skill

**Purpose:** Fix skill documentation when it has incorrect instructions or outdated API references.

**When to use:** When a skill isn't working correctly due to documentation issues.

---

### /report-bug

**Purpose:** Report bugs in the plugin with structured templates.

**When to use:** When you find something wrong with the compound engineering plugin.

---

### /release-docs

**Purpose:** Build and update the documentation site with current plugin components.

**When to use:** After adding new agents, commands, or skills to the plugin.

---

### /deploy-docs

**Purpose:** Validate and prepare documentation for GitHub Pages deployment.

**When to use:** When publishing documentation updates.

---

### /agent-native-audit

**Purpose:** Run comprehensive agent-native architecture review with scored principles.

**When to use:** When you want to verify your codebase is accessible to AI agents, not just humans.

**What it does:**
1. Analyzes your environment for agent accessibility
2. Checks if agents can run tests, access logs, create PRs
3. Scores your setup against agent-native principles
4. Provides recommendations for improvement

---

### /feature-video

**Purpose:** Record a video walkthrough of a feature and add it to the PR description.

**When to use:** When you want to demonstrate a feature visually for reviewers or stakeholders.

---

### /xcode-test

**Purpose:** Build and test iOS apps on simulator using XcodeBuildMCP.

**When to use:** When developing iOS applications and need to run tests on the simulator.

---

## Command Combinations

Here are some common workflows combining multiple commands:

### Standard Feature Development
```
/plan "Add user authentication"
# Review and approve plan
/work
/review
/resolve_pr_parallel
# Merge
/compound
```

### Quick Bug Fix
```
/reproduce-bug "Users can't login on Safari"
# Understand the issue
/plan "Fix Safari login bug" fast
/work
/review
# Merge
/compound
```

### Thorough Feature with Deep Planning
```
/plan "Implement subscription billing" ultra-think
/deepen-plan
/plan_review
# Approve enhanced plan
/work
/review
/test-browser
# Merge
/compound
```

### Full Autonomous
```
/lfg "Add email verification for new signups"
# Approve plan when prompted
# Review final PR
# Merge
```

---

## Tips for Effective Command Use

1. **Don't skip /plan.** Even for "simple" things, a quick plan catches issues early.

2. **Always /review before merge.** The agents catch things you miss.

3. **/compound after solving hard problems.** Your future self will thank you.

4. **Use /resolve_pr_parallel, not manual fixes.** Let the agent fix what the review found.

5. **/lfg for routine features.** Once you trust the process, let it run.

6. **Customize commands for your workflow.** The defaults are a starting point.
