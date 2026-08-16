# Long-form collaboration protocol

## Decide the operation semantically

- Explore or compare directions: answer in conversation.
- Create a new book: discuss the core, then propose confirmation.
- Write the next chapter or several sequential chapters: use the writer pipeline after explicit execution intent.
- Diagnose an existing chapter: use the auditor and show concrete findings.
- Rewrite or restructure an existing chapter: use the reviser with the user's instruction and appropriate revision mode.
- Change durable setting: explain conflicts, then use the truth-editing path after explicit authorization.
- Retcon published history: stop and present the conflict and affected scope before editing.

## Completion

Completion comes from persisted artifacts and tool results, not assistant prose. Preserve failed review details and let the user choose whether to revise, accept, or change the standard.
