---
name: compound-engineering
description: Compound engineering workflow - Plan → Work → Review → Compound loop. Use when starting significant work, after completing features, or when asked to apply compound engineering principles.
---

# Compound Engineering

Core principle: **Each unit of work should make subsequent work easier.**

## The Main Loop

For any significant piece of work, follow this four-step loop:

```
Plan → Work → Review → Compound
```

### 1. PLAN

Transform an idea into a detailed blueprint. The better the plan, the better the result.

**Small tasks (quick fixes, single-file changes):**
- Minimal research needed
- Quick plan, fast execution

**Medium tasks (standard features):**
- Multi-file changes
- Research codebase patterns
- Clear but detailed plan

**Large tasks (complex features):**
- Architectural changes
- Multiple research angles
- Detailed plan with edge cases and rollback

**Use the `plan` subagent** for complex planning:
```
Task(
  subagent_type="plan",
  description="Design the feature",
  prompt="[Detailed requirements and context]"
)
```

**A good plan includes:**
- Context: Why are we doing this?
- Approach: How will we solve it?
- Files: What needs to change?
- Edge cases: What could go wrong?
- Tests: What validates this works?
- Rollback: How do we revert if needed?

### 2. WORK

Execute the plan autonomously. For substantial work, use subagents:

**For implementation:**
```
Task(
  subagent_type="general-purpose",
  description="Implement the feature",
  prompt="[Plan from step 1]",
  run_in_background=True  # If appropriate
)
```

**For parallel work streams:**
Launch multiple background tasks for independent features.

### 3. REVIEW

Multi-agent review catches issues before they ship. Use specialized review subagents:

- **security-reviewer**: Vulnerabilities, auth flaws, injection attacks
- **performance-reviewer**: N+1 queries, caching, bottlenecks
- **architecture-reviewer**: Patterns, boundaries, code smells

Launch reviews in parallel:
```
Task(subagent_type="security-reviewer", ...)
Task(subagent_type="performance-reviewer", ...)
Task(subagent_type="architecture-reviewer", ...)
```

**Review findings should be prioritized:**
- P1 (Critical): Must fix before merge
- P2 (Important): Should fix
- P3 (Minor): Nice to have

### 4. COMPOUND

Turn this cycle's learnings into next cycle's advantages.

**After solving a problem:**
1. Use `/skill` to capture the solution
2. Document: problem, root cause, solution, prevention
3. Tag for searchability (yaml frontmatter)
4. Store in `.skills/compounds/` or update memory

**The $100 Rule:**
When something fails that should have been prevented, create a permanent fix:
- Add a test
- Add a rule
- Add an eval
- Update a memory block

**What to compound:**
- Bug fixes that took time to diagnose
- Patterns that could apply elsewhere
- Mistakes to avoid next time
- Preferences about approach

## When NOT to Use Full Loop

- Trivial changes (typos, single-line fixes)
- Exploratory research (not building something)
- When explicitly told to skip planning

## The Flywheel

Each cycle makes the next one better:
1. First review is slow (teaching the system)
2. Second review is faster (system remembers)
3. Tenth review catches things you used to miss
4. Hundredth review runs autonomously

This is compound engineering: work that makes future work easier.

## Integration with Letta Features

- **Memory blocks**: Store extracted taste and preferences
- **Skills**: Capture reusable patterns
- **Subagents**: Delegate planning, work, and review
- **Hooks**: Automate the compound step (Stop hook triggers skill creation)

## Example Full Cycle

**Day 1: Plan**
```
> Use the plan subagent to design comment notifications
```

**Day 1-2: Work**
```
> Use a general-purpose subagent to implement the plan in the background
```

**Day 2: Review**
```
> Launch security, performance, and architecture reviewers in parallel
> Address P1 and P2 findings
```

**Day 2: Compound**
```
> /skill "Email notification patterns"
```

**Result:** Next notification feature takes half the time because the pattern is codified.
