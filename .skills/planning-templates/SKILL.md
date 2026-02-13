---
name: planning-templates
description: Templates for different plan fidelities (small/medium/large). Use when creating implementation plans to match complexity to planning depth.
---

# Planning Templates

Different tasks need different planning depths. Use these templates to match planning effort to task complexity.

## Quick Assessment

**Use Small if:**
- Single file change
- Bug fix with known cause
- Straightforward addition
- <1 hour of work

**Use Medium if:**
- Multi-file changes
- New functionality
- Requires researching patterns
- 1-4 hours of work

**Use Large if:**
- Architectural changes
- Complex feature with edge cases
- Multiple concerns to coordinate
- >4 hours of work or unknown scope

## Small Plan Template

For quick tasks and known solutions.

```markdown
## Task
[One sentence description]

## Files to Change
- file1.ts (add validation)
- file2.ts (update type)

## Approach
[2-3 sentences on the solution]

## Testing
[How to verify it works]
```

**Example:**
```markdown
## Task
Fix typo in error message for invalid email

## Files to Change
- src/validators/email.ts (line 45)

## Approach
Update error message from "Invalid email format" to "Please enter a valid email address"

## Testing
Run existing validator tests, all should pass
```

## Medium Plan Template

For standard features requiring coordination.

```markdown
## Context
Why are we doing this? What problem does it solve?

## Requirements
- Functional requirement 1
- Functional requirement 2
- Non-functional (performance, security)

## Approach
### High-level strategy
[How will we solve this?]

### Files to Change
- file1.ts: what changes
- file2.ts: what changes

### Files to Create
- newFile.ts: purpose

## Edge Cases
- Edge case 1: how to handle
- Edge case 2: how to handle

## Testing Strategy
- Unit tests for X
- Integration test for Y
- Manual verification of Z

## Rollback Plan
If this breaks: [how to revert]
```

**Example:**
```markdown
## Context
Users need email notifications when they receive comments. Currently no notification system exists.

## Requirements
- Send email when user receives comment
- User preference to enable/disable
- Async delivery (don't block API response)
- Track delivery status

## Approach
### High-level strategy
Create notification service with background job processor

### Files to Change
- src/api/comments.ts: call notification service after create
- src/config/types.ts: add notification config

### Files to Create
- src/services/notificationService.ts: email delivery logic
- src/jobs/sendNotificationJob.ts: background worker
- src/models/notification.ts: delivery tracking

## Edge Cases
- User has notifications disabled: skip silently
- Email delivery fails: log error, retry up to 3 times
- Comment deleted before notification sent: cancel job

## Testing Strategy
- Unit tests for notificationService
- Integration test: create comment → verify job queued
- Manual: receive actual email in dev environment

## Rollback Plan
If emails not sending: disable feature flag, investigate logs
If too many emails: add rate limiting config
```

## Large Plan Template

For complex features with architectural impact.

```markdown
## Context & Motivation
### Problem
[What are we solving?]

### Why Now
[Why is this important?]

### Success Criteria
[How do we know this is done well?]

## Requirements Analysis
### Functional Requirements
1. Requirement 1
   - Detail a
   - Detail b

### Non-Functional Requirements
- Performance: [targets]
- Security: [considerations]
- Scalability: [concerns]

### Out of Scope
[What we're explicitly NOT doing]

## Research Phase
### Existing Patterns
[Similar implementations in our codebase]

### External Best Practices
[Industry standards, framework recommendations]

### Dependencies
[Libraries, services, infrastructure needed]

## Design
### Architecture Diagram
[High-level component relationships]

### Data Flow
[How data moves through the system]

### API Design
[Endpoints, request/response shapes]

### Database Changes
[Schema migrations, indexes]

## Implementation Plan
### Phase 1: [Foundation]
- Task 1
- Task 2

### Phase 2: [Core Functionality]
- Task 3
- Task 4

### Phase 3: [Integration & Polish]
- Task 5
- Task 6

## Files Affected
### To Modify
- file1.ts: [changes]
- file2.ts: [changes]

### To Create
- newModule/: [purpose]

### To Deprecate
- oldFile.ts: [migration plan]

## Edge Cases & Error Handling
### Happy Path
[Normal flow]

### Error Scenarios
1. Error 1: [detection and handling]
2. Error 2: [detection and handling]

## Testing Strategy
### Unit Tests
[What to test at unit level]

### Integration Tests
[What to test end-to-end]

### Load Tests
[Performance validation]

### Manual QA Checklist
- [ ] Item 1
- [ ] Item 2

## Deployment Strategy
### Feature Flags
[Gradual rollout plan]

### Monitoring
[Metrics to watch]

### Rollback Plan
[How to revert if problems arise]

### Migration Path
[For existing data/users]

## Risks & Mitigation
| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Risk 1 | Medium | High | [Strategy] |

## Timeline Estimate
- Phase 1: X days
- Phase 2: Y days
- Phase 3: Z days
- Total: W days

## Open Questions
- [ ] Question 1?
- [ ] Question 2?
```

## Using Plans with Subagents

**For complex plans, use the plan subagent:**
```
Task(
  subagent_type="plan",
  description="Design user authentication system",
  prompt="[Requirements and context - be thorough]"
)
```

**The subagent will:**
1. Research your codebase for similar patterns
2. Consider architectural implications
3. Create a detailed plan matching the appropriate template

**After planning, review and refine before implementation.**

## Plan Quality Checklist

A good plan should:
- [ ] Clearly state the problem and why we're solving it
- [ ] Include specific file paths and changes
- [ ] Address edge cases and error scenarios
- [ ] Have a testing strategy
- [ ] Include a rollback plan
- [ ] Be detailed enough for someone else to implement
- [ ] Not include implementation details in code (save for Work phase)

**If you can't implement from the plan alone, the plan needs more detail.**
