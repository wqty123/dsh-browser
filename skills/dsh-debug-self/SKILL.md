---
name: dsh-debug-self
description: Use when a browser or DSH behaviour has failed more than once, or when the obvious explanation is environmental (needs a restart, a cache, a stale build). Turns a repeated failure into one measurable check so the same cause is not re-guessed, and records the check next to the work.
---

# Debugging without re-guessing

A repeated failure is not a new situation. It is the same one arriving again, and the second arrival
means the first explanation was never actually checked.

## The loop

1. **Write down what was observed, not what was concluded.** A tool returned `{title: "", elements: []}`;
   a file contains `surface: "builtin"`; a log line printed `surface=panel`. Inferences ("needs a
   restart", "the cache is stale") are hypotheses and belong in the next step, not this one.
2. **Move one variable per trial.** If two things changed between a working and a broken run, the result
   distinguishes nothing. Change one, re-run, note the outcome.
3. **Prefer a value the system prints over a value you compute.** A field in a response, a log line at
   registration, a file's own contents — these are facts. Reconstructing the same fact from behaviour
   ("it must be X because it did not do Y") is how the same wrong guess survives a whole session.
4. **Turn the conclusion into a check.** Something a later run can evaluate in one call: a field to read,
   a path to stat, a line to grep. If it cannot be written as a check, it is not a conclusion yet.
5. **Run the check first, every time after that.** Before touching code again, evaluate the check. That
   is what stops the loop.

## Signs the loop is happening

- The same wording appears in two rounds of notes ("this needs a restart").
- A change was made and its effect was never isolated from another change.
- Behaviour is explained by the environment while a fact that would settle it is one call away.
- The same file is edited repeatedly without any observation in between.

## What to record when closing one

Next to the fix, in the repo rather than in chat: the observed fact, the check, and the one-line rule it
implies. A note that cannot be re-evaluated by the next reader is a story, not a finding.
## 判据必须落在动作之前

事后报错等于没有预防：调用已经发生，代价已经付出，用户看到的是"你又犯了一次"。

因此每一条要留下的教训，最终形态必须是**动作前的一次判定**，而不是动作后的一条消息：

1. 把错误写成前置条件：「当 X 成立时，动作 A 不可执行」。
2. 这个判定要放在**最早能拦住 A 的位置**——能写进代码就写进代码（拒绝在发起之前），只能人工就写进调用前的检查清单。
3. 只在"事后"出现的提示不算完成。判据的验收标准是：**违规的那次调用根本没有发出去**。
4. 反例（不合格）：代理返回 403 并附带说明。合格：代理在收到请求之前就拒绝，或工具在发起之前就不允许这次调用。

例：侧栏（同源代理）不能承载本机地址，因为那等于让代理去抓自己所在的服务器。
不合格做法——先发起，再由代理返回"不能到达 127.0.0.1"；
合格做法——`panel` 面遇到 loopback 目标时，在 `open` 发起之前就拒绝，并指出应当改用 `builtin` 面。
