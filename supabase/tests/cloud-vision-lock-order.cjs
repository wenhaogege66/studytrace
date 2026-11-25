/* eslint-disable @typescript-eslint/no-require-imports -- Standalone CommonJS harness using Node built-ins. */
// Local-only harness: two writer connections plus an observer/barrier connection.
// Apply migrations in a disposable studytrace_final_fix database before running.
const { spawn } = require("node:child_process")
const { randomUUID } = require("node:crypto")
const assert = require("node:assert/strict")
const readline = require("node:readline")
const phase = process.argv[2] || "green"
assert(["red", "green"].includes(phase))
const connections = []
function connect() {
  const child = spawn(
    "psql",
    [
      "-X",
      "-Atq",
      "-h",
      "/tmp/studytrace-cloud-vision",
      "-p",
      "55439",
      "-U",
      "postgres",
      "-d",
      "studytrace_final_fix",
      "-v",
      "VERBOSITY=verbose",
    ],
    { env: { PATH: process.env.PATH, HOME: "/tmp", LC_ALL: "C" } },
  )
  let pending
  let sequence = 0
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    if (!pending) return
    if (line === pending.marker) {
      const result = pending
      pending = undefined
      result.resolve({ output: result.lines.join("\n"), error: result.error })
    } else pending.lines.push(line)
  })
  child.stderr.on("data", (data) => {
    if (pending) pending.error += data.toString()
  })
  child.on("exit", () => {
    if (pending) pending.reject(new Error("psql exited during query"))
  })
  const connection = {
    async query(sql) {
      assert(!pending, "One query per connection")
      const result = await new Promise((resolve, reject) => {
        const marker = `done_${++sequence}`
        pending = { marker, lines: [], error: "", resolve, reject }
        child.stdin.write(`${sql}\n\\echo ${marker}\n`)
      })
      return result
    },
    async ok(sql) {
      const result = await this.query(sql)
      assert(!result.error.includes("ERROR:"), result.error)
      return result.output
    },
    close() {
      child.stdin.end("\\q\n")
    },
  }
  connections.push(connection)
  return connection
}
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function blocked(observer, waiting, holder) {
  const deadline = Date.now() + 4000
  while (Date.now() < deadline) {
    if (
      (await observer.ok(
        `select ${holder} = any(pg_blocking_pids(${waiting}));`,
      )) === "t"
    )
      return
    await delay(10)
  }
  throw new Error("Expected controlled lock wait did not occur")
}
const observation = `'{"signal":"unknown","taskRelevance":"uncertain","summary":"Synthetic lock test"}'::jsonb`
async function main() {
  const observer = connect()
  const cloud = connect()
  const local = connect()
  for (const connection of [observer, cloud, local])
    await connection.ok("set lc_messages = 'C';")
  const cloudPid = Number(await cloud.ok("select pg_backend_pid();"))
  const localPid = Number(await local.ok("select pg_backend_pid();"))
  const observerPid = Number(await observer.ok("select pg_backend_pid();"))
  await observer.ok(`
    create function private.test_cloud_insert_barrier() returns trigger
    language plpgsql set search_path = '' as $$
    begin
      if new.source = 'cloud_vision' then
        perform pg_catalog.pg_advisory_xact_lock(777001);
      end if;
      return new;
    end;
    $$;
    create trigger behavior_events_01_test_cloud_barrier before insert on public.behavior_events
    for each row execute function private.test_cloud_insert_barrier();
    create temp table lock_context(session_id uuid, token uuid, request_id uuid);
  `)
  try {
    for (const ordering of ["cloud-first", "local-first"]) {
      const user = randomUUID()
      await observer.ok(`
        insert into auth.users(id,is_anonymous) values('${user}',true);
        select set_config('request.jwt.claim.sub','${user}',false);
        truncate lock_context;
        do $$
        declare task_id uuid; session public.study_sessions; token uuid; request_id uuid;
        begin
          insert into public.tasks(user_id,title,steps,estimated_minutes,observation_profile)
          values('${user}','Synthetic lock test','[{"id":"one","title":"Read","completed":false}]',20,'study_paper_v1')
          returning id into task_id;
          session := public.start_study_session(task_id,false,false);
          session := public.set_study_session_camera(session.id,session.state_version,1,true);
          token := public.set_vision_consent(session.id,true);
          select r.request_id into request_id from public.reserve_vision_observation(session.id,token) r;
          insert into lock_context values(session.id,token,request_id);
        end;
        $$;
      `)
      const context = JSON.parse(
        await observer.ok(
          "select row_to_json(lock_context) from lock_context;",
        ),
      )
      for (const actor of [cloud, local])
        await actor.ok(`
        begin;
        set local deadlock_timeout = '200ms';
        set local statement_timeout = '6s';
        select set_config('request.jwt.claim.sub','${user}',true);
        set local role authenticated;
      `)
      const save = `select (public.save_vision_observation('${context.session_id}','${context.token}','${context.request_id}',${observation})).id;`
      const insert = `insert into public.behavior_events(user_id,session_id,event_type,source,started_at,ended_at)
        values('${user}','${context.session_id}','manual','manual',clock_timestamp(),clock_timestamp()) returning id;`
      let cloudResult, localResult
      if (ordering === "cloud-first") {
        await observer.ok("begin; select pg_advisory_xact_lock(777001);")
        const saving = cloud.query(save)
        await blocked(observer, cloudPid, observerPid)
        const inserting = local.query(insert)
        await blocked(observer, localPid, cloudPid)
        const wait = await observer.ok(
          `select wait_event from pg_stat_activity where pid = ${localPid};`,
        )
        console.log(
          `${phase} ${ordering}: local waits on ${wait}; cloud paused at actual event insert`,
        )
        await observer.ok("commit;")
        // Commit whichever writer finishes first to release its transaction locks.
        const first = await Promise.race([
          saving.then((result) => ({ actor: cloud, result })),
          inserting.then((result) => ({ actor: local, result })),
        ])
        await first.actor.ok(
          first.result.error.includes("ERROR:") ? "rollback;" : "commit;",
        )
        cloudResult = await saving
        localResult = await inserting
        const second = first.actor === cloud ? local : cloud
        const secondResult = second === cloud ? cloudResult : localResult
        await second.ok(
          secondResult.error.includes("ERROR:") ? "rollback;" : "commit;",
        )
      } else {
        localResult = await local.query(insert)
        assert(!localResult.error.includes("ERROR:"), localResult.error)
        const saving = cloud.query(save)
        await blocked(observer, cloudPid, localPid)
        console.log(
          `${phase} ${ordering}: actual cloud RPC waits for local transaction`,
        )
        await local.ok("commit;")
        cloudResult = await saving
        await cloud.ok(
          cloudResult.error.includes("ERROR:") ? "rollback;" : "commit;",
        )
      }
      const errors = [cloudResult.error, localResult.error].filter((error) =>
        error.includes("ERROR:"),
      )
      if (phase === "red" && ordering === "cloud-first") {
        assert.equal(errors.length, 1)
        assert.match(errors[0], /40P01: deadlock detected/)
        console.log(
          "RED: actual cloud save/local insert deadlock (40P01), one writer aborted",
        )
      } else {
        assert.deepEqual(errors, [])
        const counts =
          await observer.ok(`select count(*), count(*) filter(where source='cloud_vision'),
          count(*) filter(where source='manual') from public.behavior_events where user_id='${user}';`)
        assert.equal(counts, "2|1|1")
        assert.equal(
          await observer.ok(
            `select consumed from private.vision_reservations where session_id='${context.session_id}';`,
          ),
          "t",
        )
        console.log(
          `GREEN ${ordering}: both writers committed; exactly one local + one cloud event; reservation consumed`,
        )
      }
      await observer.ok(`delete from public.behavior_events where user_id='${user}';
        delete from public.study_sessions where user_id='${user}';
        delete from public.tasks where user_id='${user}';
        delete from auth.users where id='${user}';`)
    }
  } finally {
    await observer.ok(
      "rollback; drop trigger behavior_events_01_test_cloud_barrier on public.behavior_events; drop function private.test_cloud_insert_barrier();",
    )
  }
}
main()
  .catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
  .finally(() => connections.forEach((connection) => connection.close()))
