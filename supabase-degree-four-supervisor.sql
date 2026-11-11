alter table if exists public.students
  add column if not exists created_by_supervisor text,
  add column if not exists supervisor_created_at timestamptz,
  add column if not exists force_password_change boolean not null default false,
  add column if not exists telegram_verification_code text;

update public.students
set "نوع التسجيل" = 'عرب أجانب'
where "نوع التسجيل" in ('عرب', 'أجانب');

create index if not exists students_created_by_supervisor_idx
  on public.students (created_by_supervisor, supervisor_created_at desc);

create or replace function public.prevent_duplicate_student_university_id()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_student_id text;
begin
  if new."الرقم الجامعي" is null or btrim(new."الرقم الجامعي"::text) = '' then
    return new;
  end if;
  if tg_op = 'UPDATE' then
    if new."الرقم الجامعي" is not distinct from old."الرقم الجامعي" then
      return new;
    end if;
  end if;

  if translate(btrim(new."الرقم الجامعي"::text), '٠١٢٣٤٥٦٧٨٩', '0123456789') !~ '^[0-9]+$' then
    return new;
  end if;

  v_student_id := coalesce(
    nullif(ltrim(translate(btrim(new."الرقم الجامعي"::text), '٠١٢٣٤٥٦٧٨٩', '0123456789'), '0'), ''),
    '0'
  );
  perform pg_advisory_xact_lock(hashtext(v_student_id));

  if tg_op = 'UPDATE' then
    if exists (
      select 1
      from public.students s
      where s.ctid <> old.ctid
        and coalesce(
          nullif(ltrim(translate(btrim(s."الرقم الجامعي"::text), '٠١٢٣٤٥٦٧٨٩', '0123456789'), '0'), ''),
          '0'
        ) = v_student_id
    ) then
      raise exception using errcode = '23505', constraint = 'students_university_id_normalized_unique';
    end if;
  elsif exists (
    select 1
    from public.students s
    where coalesce(
      nullif(ltrim(translate(btrim(s."الرقم الجامعي"::text), '٠١٢٣٤٥٦٧٨٩', '0123456789'), '0'), ''),
      '0'
    ) = v_student_id
  ) then
    raise exception using errcode = '23505', constraint = 'students_university_id_normalized_unique';
  end if;

  return new;
end;
$$;

drop trigger if exists students_university_id_unique_trigger on public.students;
create trigger students_university_id_unique_trigger
before insert or update on public.students
for each row execute function public.prevent_duplicate_student_university_id();

revoke all on function public.prevent_duplicate_student_university_id() from public, anon, authenticated;
grant execute on function public.prevent_duplicate_student_university_id() to service_role;

create index if not exists students_university_id_normalized_idx
  on public.students ((
    coalesce(
      nullif(ltrim(translate(btrim("الرقم الجامعي"::text), '٠١٢٣٤٥٦٧٨٩', '0123456789'), '0'), ''),
      '0'
    )
  ))
  where translate(btrim("الرقم الجامعي"::text), '٠١٢٣٤٥٦٧٨٩', '0123456789') ~ '^[0-9]+$';

create or replace function public.check_student_university_id(p_student_id text)
returns table(student_id text, student_name text)
language sql
security definer
set search_path = public, pg_temp
as $$
  select
    s."الرقم الجامعي"::text,
    concat_ws(' ', s."اسم الطالب"::text, s."اسم الاب"::text, s."الكنية"::text)
  from public.students s
  where coalesce(
    nullif(ltrim(translate(btrim(s."الرقم الجامعي"::text), '٠١٢٣٤٥٦٧٨٩', '0123456789'), '0'), ''),
    '0'
  ) = coalesce(nullif(ltrim(translate(btrim(p_student_id), '٠١٢٣٤٥٦٧٨٩', '0123456789'), '0'), ''), '0')
  limit 1;
$$;

revoke all on function public.check_student_university_id(text) from public, anon, authenticated;
grant execute on function public.check_student_university_id(text) to service_role;

create or replace function public.suggest_student_university_id()
returns text
language sql
security definer
set search_path = public, pg_temp
as $$
  with numeric_ids as (
    select coalesce(
      nullif(ltrim(translate(btrim(s."الرقم الجامعي"::text), '٠١٢٣٤٥٦٧٨٩', '0123456789'), '0'), ''),
      '0'
    )::numeric as serial
    from public.students s
    where translate(btrim(s."الرقم الجامعي"::text), '٠١٢٣٤٥٦٧٨٩', '0123456789') ~ '^[0-9]+$'
  ),
  next_id as (
    select (coalesce(max(serial), 0) + 1)::text as serial
    from numeric_ids
  )
  select case when length(serial) >= 4 then serial else lpad(serial, 4, '0') end
  from next_id;
$$;

revoke all on function public.suggest_student_university_id() from public, anon, authenticated;
grant execute on function public.suggest_student_university_id() to service_role;

drop function if exists public.search_students_for_degree4(text);

create function public.search_students_for_degree4(p_query text, p_offset integer, p_limit integer)
returns table(student_id text, student_name text, phone text)
language sql
security definer
set search_path = public, pg_temp
as $$
  with search_term as (
    select lower(btrim(p_query)) as text_value,
      translate(btrim(p_query), '٠١٢٣٤٥٦٧٨٩', '0123456789') as digit_value
  )
  select
    s."الرقم الجامعي"::text,
    concat_ws(' ', s."اسم الطالب"::text, s."اسم الاب"::text, s."الكنية"::text),
    coalesce(s."رقم الهاتف"::text, '')
  from public.students s
  cross join search_term q
  where length(q.text_value) >= 2
    and (
      position(q.text_value in lower(concat_ws(' ', s."اسم الطالب"::text, s."اسم الاب"::text, s."الكنية"::text))) > 0
      or position(q.text_value in lower(coalesce(s."رقم الهاتف"::text, ''))) > 0
      or position(q.digit_value in translate(btrim(s."الرقم الجامعي"::text), '٠١٢٣٤٥٦٧٨٩', '0123456789')) > 0
    )
  order by s."الرقم الجامعي"::text
  limit greatest(1, least(coalesce(p_limit, 500), 500))
  offset greatest(coalesce(p_offset, 0), 0);
$$;

revoke all on function public.search_students_for_degree4(text, integer, integer) from public, anon, authenticated;
grant execute on function public.search_students_for_degree4(text, integer, integer) to service_role;

create or replace function public.available_student_classes_for_year(p_year text)
returns table(name text, capacity integer, occupied bigint, available bigint)
language sql
security definer
set search_path = public, pg_temp
as $$
  with selected_year as (
    select case
      when translate(lower(regexp_replace(btrim(p_year), '[[:space:]]', '', 'g')), '١٢', '12') in ('أولى', 'اولى', '1') then 'أولى'
      when translate(lower(regexp_replace(btrim(p_year), '[[:space:]]', '', 'g')), '١٢', '12') in ('ثانية', '2') then 'ثانية'
      else null
    end as year_name
  ),
  class_counts as (
    select
      c.name::text as class_name,
      c.capacity::integer as seat_capacity,
      count(s."الرقم الجامعي")::bigint as seat_occupancy
    from public.student_classes c
    cross join selected_year y
    left join public.students s
      on translate(lower(regexp_replace(coalesce(s."السنه الدراسية"::text, ''), '[[:space:]]', '', 'g')), '١٢', '12') = lower(y.year_name)
      and regexp_replace(lower(regexp_replace(btrim(coalesce(s."الفئة"::text, '')), '^(الفئة|فئة)[[:space:]]*', '', 'i')), '[[:space:]]', '', 'g')
        = regexp_replace(lower(regexp_replace(btrim(c.name::text), '^(الفئة|فئة)[[:space:]]*', '', 'i')), '[[:space:]]', '', 'g')
    where lower(c.student_year::text) = lower(y.year_name)
    group by c.name, c.capacity
  )
  select class_name, seat_capacity, seat_occupancy, (seat_capacity - seat_occupancy)::bigint
  from class_counts
  where seat_capacity > seat_occupancy
  order by class_name;
$$;

revoke all on function public.available_student_classes_for_year(text) from public, anon, authenticated;
grant execute on function public.available_student_classes_for_year(text) to service_role;

create table if not exists public.degree4_supervisor_tickets (
  id uuid primary key default gen_random_uuid(),
  ticket_type text not null check (ticket_type in ('general', 'student_update')),
  student_id text,
  requester_username text not null,
  description text not null check (char_length(description) between 3 and 3000),
  requested_changes jsonb not null default '{}'::jsonb,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  reviewer_username text,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint degree4_ticket_student_update_id_check
    check (ticket_type <> 'student_update' or student_id is not null)
);

create index if not exists degree4_supervisor_tickets_status_created_idx
  on public.degree4_supervisor_tickets (status, created_at desc);

create index if not exists degree4_supervisor_tickets_requester_idx
  on public.degree4_supervisor_tickets (requester_username, created_at desc);

alter table public."سجلات النظام"
  drop constraint if exists system_logs_user_type_check;

alter table public."سجلات النظام"
  drop constraint if exists "سجلات النظام_user_type_check";

alter table public."سجلات النظام"
  add constraint system_logs_user_type_check
  check (user_type in ('student', 'teacher', 'supervisor', 'support_supervisor', 'system'));

alter table public.degree4_supervisor_tickets enable row level security;
revoke all on public.degree4_supervisor_tickets from anon, authenticated;
grant all on public.degree4_supervisor_tickets to service_role;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', true, 2097152, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
set public = true,
    file_size_limit = 2097152,
    allowed_mime_types = excluded.allowed_mime_types;

create or replace function public.review_degree4_supervisor_ticket(
  p_ticket_id uuid,
  p_decision text,
  p_reviewer text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_ticket public.degree4_supervisor_tickets%rowtype;
  v_student_year text;
begin
  if p_decision not in ('approved', 'rejected') then
    raise exception 'invalid_ticket_decision';
  end if;

  select * into v_ticket
  from public.degree4_supervisor_tickets
  where id = p_ticket_id
  for update;

  if not found then
    raise exception 'ticket_not_found';
  end if;
  if v_ticket.status <> 'pending' then
    raise exception 'ticket_already_reviewed';
  end if;

  if p_decision = 'approved' and v_ticket.ticket_type = 'student_update' then
    select "السنه الدراسية"::text into v_student_year
    from public.students
    where coalesce(
      nullif(ltrim(translate(btrim("الرقم الجامعي"::text), '٠١٢٣٤٥٦٧٨٩', '0123456789'), '0'), ''),
      '0'
    ) = coalesce(
      nullif(ltrim(translate(btrim(v_ticket.student_id), '٠١٢٣٤٥٦٧٨٩', '0123456789'), '0'), ''),
      '0'
    )
    limit 1
    for update;
    if not found then
      raise exception 'ticket_student_not_found';
    end if;

    if nullif(v_ticket.requested_changes ->> 'الفئة', '') is not null
      and not exists (
        select 1
        from public.available_student_classes_for_year(
          coalesce(v_ticket.requested_changes ->> 'السنه الدراسية', v_student_year)
        ) available_class
        where available_class.name = v_ticket.requested_changes ->> 'الفئة'
      ) then
      raise exception 'ticket_student_class_unavailable';
    end if;

    update public.students
    set
      "اسم الطالب" = coalesce(v_ticket.requested_changes ->> 'اسم الطالب', "اسم الطالب"),
      "اسم الاب" = coalesce(v_ticket.requested_changes ->> 'اسم الاب', "اسم الاب"),
      "الكنية" = coalesce(v_ticket.requested_changes ->> 'الكنية', "الكنية"),
      "رقم الهاتف" = coalesce(
        regexp_replace(translate(v_ticket.requested_changes ->> 'رقم الهاتف', '٠١٢٣٤٥٦٧٨٩', '0123456789'), '^0+', ''),
        "رقم الهاتف"
      ),
      "البريد الإلكتروني" = coalesce(v_ticket.requested_changes ->> 'البريد الإلكتروني', "البريد الإلكتروني"),
      "نوع التسجيل" = coalesce(v_ticket.requested_changes ->> 'نوع التسجيل', "نوع التسجيل"),
      "القسم" = coalesce(v_ticket.requested_changes ->> 'القسم', "القسم"),
      "الفئة" = coalesce(v_ticket.requested_changes ->> 'الفئة', "الفئة"),
      "السنه الدراسية" = coalesce(v_ticket.requested_changes ->> 'السنه الدراسية', "السنه الدراسية"),
      telegram_verification_code = coalesce(v_ticket.requested_changes ->> 'telegram_verification_code', telegram_verification_code),
      force_password_change = case
        when v_ticket.requested_changes ->> 'السنه الدراسية' = 'أولى' then true
        else force_password_change
      end
    where coalesce(
      nullif(ltrim(translate(btrim("الرقم الجامعي"::text), '٠١٢٣٤٥٦٧٨٩', '0123456789'), '0'), ''),
      '0'
    ) = coalesce(
      nullif(ltrim(translate(btrim(v_ticket.student_id), '٠١٢٣٤٥٦٧٨٩', '0123456789'), '0'), ''),
      '0'
    );
    if not found then
      raise exception 'ticket_student_not_found';
    end if;
  end if;

  update public.degree4_supervisor_tickets
  set status = p_decision,
      reviewer_username = p_reviewer,
      reviewed_at = now()
  where id = p_ticket_id;

  return jsonb_build_object('success', true, 'status', p_decision);
end;
$$;

revoke all on function public.review_degree4_supervisor_ticket(uuid, text, text) from public, anon, authenticated;
grant execute on function public.review_degree4_supervisor_ticket(uuid, text, text) to service_role;
