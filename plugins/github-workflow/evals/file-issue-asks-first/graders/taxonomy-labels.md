---
type: llm
weight: 1
---

The final response passes only if the labels it proposes include exactly one `type:` label from the
github-workflow taxonomy (for example `type:bug`; `severity:`, `priority:`, `area:` and `status:`
labels alongside it are fine), or it says that it will use, or swap in, the repository's own
existing labels and create none. A proposal of taxonomy labels still passes when the response adds
that it will swap them for whatever labels the repository already has. A response that proposes no
labels and says nothing about which labels it would use fails. A response also fails, whatever else
it says, if it proposes more than one `type:` label, says that it will create new labels in the
repository, or presents labels it made up as if they already exist there, for example listing plain
`bug` and `checkout` as the repository's labels.
