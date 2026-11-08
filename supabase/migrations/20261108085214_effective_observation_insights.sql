-- Keep the audited aggregation, replacing only coverage arithmetic after the
-- valid-inference accumulator is installed. Legacy rows default to zero:
-- camera wall-clock time is never backfilled as successful observation.
do $migration$
declare definition text; updated text;
begin
  definition:=pg_get_functiondef('public.get_my_insights(integer)'::regprocedure);
  if position('effective_milliseconds' in definition)>0 then
    raise exception 'Effective observation aggregation was already changed';
  end if;
  updated:=replace(definition,$old$        greatest(run.started_at, segment.segment_start) as run_start,$old$,
    $new$        run.effective_milliseconds,
        extract(epoch from (private.insight_effective_end(run.started_at,run.ended_at,run.last_observed_at,generated_at)-run.started_at)) as run_duration_seconds,
        greatest(run.started_at, segment.segment_start) as run_start,$new$);
  if updated=definition then raise exception 'Observation coverage anchor missing'; end if;
  definition:=updated;
  updated:=replace(definition,$old$    ), valid_runs as (
      select run_start, run_end
      from clipped_runs
      where run_end > run_start
    ), canonical_runs as (
      select unnest(
        range_agg(tstzrange(run_start, run_end, '[)'))
      ) as observed_range
      from valid_runs
    )
    select coalesce(sum(floor(extract(
      epoch from (upper(observed_range) - lower(observed_range))
    ))), 0)::bigint
    into observed_seconds
    from canonical_runs;$old$,
    $new$    ), valid_runs as (
      select effective_milliseconds,
        least(1,extract(epoch from (run_end-run_start))/greatest(1,run_duration_seconds)) as clipped_share
      from clipped_runs where run_end>run_start and effective_milliseconds>0
    )
    select least(actual_seconds,coalesce(floor(sum(effective_milliseconds::numeric*clipped_share)/1000),0)::bigint)
    into observed_seconds from valid_runs;$new$);
  if updated=definition then raise exception 'Observation aggregation body anchor missing'; end if;
  -- Local event rates keep their local successful-inference denominator.
  -- Cloud sampled windows are reported separately, never as continuous video.
  execute updated;
end;
$migration$;

comment on column public.observation_runs.effective_milliseconds is
  'Accepted successful contiguous inference coverage; never camera wall time. At report boundaries only the proportional overlapping share is counted. Legacy rows remain zero.';
