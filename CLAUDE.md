# CLAUDE.md - Fiducial Marker Generator — Originally: AprilTag Generator

## Project goal

A static, client-side web app (TypeScript, hosted on GitHub Pages, no backend)
that generates printable PDFs of AprilTags and some other fiducial markers. The user specifies tag family,
ID range, and physical tag size; the app produces a print-ready PDF along
with assembly guidance where applicable.


The app must pack as many tags as fit per page after accounting for a quiet zone and cut margins.
Multi-page (large) tag support is deferred but the architecture must not
preclude it: a separate layout algorithm will be added later behind the
same interface.

# Improvements and Possible Changes

After reviewing other websites which have also made AprilTag generators, I have compiled a list of deficiencies and things to improve, from most important to least:

-  UI is too plain, even given STYLES.md.

# Continuous Summary Updates

Instead of reading the entire project every time you need to make a change, read STRUCTURE.md, then read only relevant files. I repeat, you do NOT need to read everything or explore the filestructure of a project. You just need to read STRUCTURE.md.

Create or update a file called STRUCTURE.md. It contains a summary of the architecture and structure of the project, a filemap containing relevant files, and each a 1-sentence summary for every file (not all files are relevant, i.e. everything in .git/ should be excluded). Update this whenever you touch or modify a file. The sentence should describe the role of the file and its place in the broader architecture of the project.

# Practices

Derived from *A Philosophy of Software Design* (Ousterhout).

- **Deep modules.** A module is deep when its interface is much smaller
  than the functionality it provides. Prefer one function that does a
  large job over many functions that each do a small piece of it. Check:
  measure interface surface (exported symbols, parameters, fields on
  returned types) against capability. If surface grows faster than what
  the module can do, it is going shallow — consolidate the interface
  rather than adding more entry points or flags.

- **Information hiding.** Callers should know what a module does, not how.
  Treat internal representations, helper types, and intermediate state as
  private by default. Check: ask whether a different reasonable
  implementation could replace the current one without changing any
  caller. If not, an internal detail is leaking and the interface needs
  to abstract over it.

- **Different layer, different abstraction.** Each layer should restate
  its inputs in its own vocabulary rather than forwarding the previous
  layer's concepts. Pass-through layers (call-throughs, thin wrappers
  that rename the same fields) add complexity without removing any.
  Check: if adjacent layers share type names and field names for the same
  values, one is a pass-through. Either give it a real job or delete it.

- **Generality where free, specificity where paid for.** Generalize a
  design when the general form is no more complex than the specific one,
  because general modules tend to be deeper. Avoid generalizing on
  speculation; wait for a second concrete use case. Check: if you cannot
  name two real callers with different needs, the generalization is
  speculative.

- **Design twice.** For any load-bearing decision (a core type, a primary
  interface, a data representation), produce at least two distinct
  candidates and choose deliberately. The second candidate often reveals
  weaknesses in the first that would otherwise surface only after the
  first is implemented. Approach: write down each candidate's interface
  and trace a representative use case through it before picking.

- **Names carry weight.** A good name is precise enough that no
  clarifying comment is required. Vague or generic names (`data`,
  `manager`, `process`) are signals the underlying concept is unclear.
  Check: if naming something is hard, the abstraction is probably wrong,
  not the vocabulary. Reconsider the design before settling for a weak
  name.

- **Comments explain why, not what.** Code already shows what it does;
  comments should capture what code cannot — invariants, constraints,
  rationale for non-obvious choices, references to external context.
  Check: read the comment and the code side by side. If the comment
  restates the code, delete it. If deleting it loses information a future
  reader would need, keep it.

- **Tests are the safety net for non-trivial logic.** Code whose output
  is structured data, numerical results, or transformed state cannot be
  verified by inspection. Cover known cases with unit tests, invariants
  with property tests, and structured outputs with snapshot tests.
  Refactoring without tests is guessing; refactoring with tests is
  routine. Approach: when adding a feature, write the test that would
  fail without it first, then implement until the test passes.

- **Fail loudly on invalid input.** Throw an error that names the
  offending parameter and the violated constraint. Silent clamping,
  defaulting, or rounding produces wrong output that looks right and
  hides bugs from both users and tests. Check: every input validation
  branch should either reject explicitly or proceed with the input
  unchanged — never substitute a different value silently.

## Tooling and Workflow

 - Always use git. Commit often, even for small changes.
    - Do not work on main directly. Always make a new branch when working on a feature, even a small feature. When you are done with that branch, halt and defer to me to merge. I will review your changes and merge appropriately.
       - If you want to still merge code and make branches and stuff (I'd advise not getting too complicated with git unless it is necessary), make a "master-branch" (please do not call it this, this is just impromptu terminology; give it appropriate and descriptive names) and then make another branch from this branch. You are allowed to merge these grandchild branches into the master branch.
    - Do not cite yourself or attribute credit to anyone in your commit message, just write what changes you made and why.
    - Do not commit without running tests.
    - Make sure to use .gitignore as needed.
 - Use a linter.
