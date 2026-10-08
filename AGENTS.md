# Runloom Desktop Development Constraints

## Maintenance-phase task admission

- Apply this gate once the project is explicitly in its maintenance phase. Adding this rule does not declare that the current project is already in maintenance.
- Do not use "完善", "优化", "增强健壮性", "重构", or "补充能力" as standalone development goals. Technical changes may be implementation means, not the user outcome.
- Before admitting any maintenance task into development, state all three:
  - **Before:** What can the user not do today, or which complete action currently fails?
  - **After:** What complete action can the user perform after this version?
  - **Demo:** How can the user personally verify the result within five minutes? Specify the entry point, necessary preconditions, steps, and observable pass/fail result.
- If no concrete five-minute Demo can be given, the task must not enter development. Clarify the user outcome first.
- Code changes, passing unit tests, test counts, and an assistant's success claim do not substitute for the user-observable Demo.
