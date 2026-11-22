# Cost-effective models and orchestration

- Default to the most cost-effective model capable of completing the task reliably, including subagents and orchestration workers.
- Use cheaper models for easy and medium tasks with well-scoped tickets, clear acceptance criteria and established patterns. For the current Claude workers, default to `sonnet`; use a comparable economical option with other providers. Do not default every worker to a flagship model.
- Reserve stronger models such as `opus` for work requiring deeper reasoning, deeper investigation, difficult design decisions or unresolved ambiguity. Routine implementation, tests, documentation, writing and PR maintenance do not require a top-tier model merely because they are delegated.
- Escalate only when a concrete difficulty warrants it, and briefly record the reason in the task or dispatch. Return well-defined follow-up work to a cheaper model.
- Keep delegation bounded with explicit ownership and validation. Avoid unnecessary agents, duplicate investigation and repeated checks; keep the coordinator context focused on orchestration, synthesis and judgment.
