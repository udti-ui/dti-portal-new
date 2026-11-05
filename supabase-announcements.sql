create table if not exists public.announcements (
  id bigint generated always as identity primary key,
  title text not null check (char_length(title) between 3 and 160),
  content text not null check (char_length(content) between 0 and 4000),
  subject text,
  student_year text,
  target_scope text not null default 'year',
  attachment_path text,
  attachment_name text,
  attachment_type text,
  attachment_size bigint,
  author_type text not null check (author_type in ('admin', 'teacher')),
  author_name text not null,
  created_at timestamptz not null default now()
);

alter table public.announcements
  add column if not exists attachment_path text,
  add column if not exists attachment_name text,
  add column if not exists attachment_type text,
  add column if not exists attachment_size bigint,
  add column if not exists author_teacher_id uuid references public.teachers(id) on delete set null,
  add column if not exists target_scope text not null default 'year',
  alter column subject drop not null,
  alter column student_year drop not null,
  drop constraint if exists announcements_content_check,
  add constraint announcements_content_check
    check (
      char_length(content) between 0 and 4000
      and (char_length(content) >= 3 or attachment_path is not null)
    );

alter table public.announcements
  drop constraint if exists announcements_student_year_check,
  drop constraint if exists announcements_target_scope_check,
  drop constraint if exists announcements_target_consistency_check,
  add constraint announcements_target_scope_check
    check (target_scope in ('year', 'all')),
  add constraint announcements_target_consistency_check
    check (
      (target_scope = 'all' and student_year is null and subject is null)
      or (target_scope = 'year' and student_year in ('أولى', 'ثانية'))
    );

create index if not exists announcements_year_created_idx
  on public.announcements (student_year, created_at desc);

create table if not exists public.announcement_reads (
  announcement_id bigint not null references public.announcements(id) on delete cascade,
  student_id text not null,
  read_at timestamptz not null default now(),
  primary key (announcement_id, student_id)
);

create index if not exists announcement_reads_student_idx
  on public.announcement_reads (student_id, announcement_id);

alter table public.announcements enable row level security;
alter table public.announcement_reads enable row level security;

revoke all on public.announcements from anon, authenticated;
revoke all on public.announcement_reads from anon, authenticated;
grant all on public.announcements to service_role;
grant all on public.announcement_reads to service_role;
grant usage, select on sequence public.announcements_id_seq to service_role;

create table if not exists public.course_lectures (
  id bigint generated always as identity primary key,
  title text not null check (char_length(title) between 1 and 180),
  subject text not null,
  student_year text not null check (student_year in ('أولى', 'ثانية')),
  teacher_id uuid references public.teachers(id) on delete set null,
  teacher_name text not null,
  file_path text not null,
  file_name text not null,
  file_size bigint not null check (file_size > 0 and file_size <= 20971520),
  created_at timestamptz not null default now()
);

create index if not exists course_lectures_subject_year_created_idx
  on public.course_lectures (subject, student_year, created_at desc);
create index if not exists course_lectures_teacher_created_idx
  on public.course_lectures (teacher_id, created_at desc);

alter table public.course_lectures enable row level security;
revoke all on public.course_lectures from anon, authenticated;
grant all on public.course_lectures to service_role;
grant usage, select on sequence public.course_lectures_id_seq to service_role;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'announcements',
  'announcements',
  false,
  5242880,
  array[
    'image/jpeg',
    'image/png',
    'image/gif',
    'image/webp',
    'application/pdf',
    'text/plain',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ]
)
on conflict (id) do update
set public = false,
    file_size_limit = 5242880,
    allowed_mime_types = excluded.allowed_mime_types;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'course-lectures',
  'course-lectures',
  false,
  20971520,
  array['application/pdf']
)
on conflict (id) do update
set public = false,
    file_size_limit = 20971520,
    allowed_mime_types = excluded.allowed_mime_types;

update public.announcements announcement
set author_teacher_id = (
  select min(teacher.id::text)::uuid
  from public.teachers teacher
  where teacher.teacher_name = announcement.author_name
)
where announcement.author_type = 'teacher'
  and announcement.author_teacher_id is null
  and (
    select count(*)
    from public.teachers teacher
    where teacher.teacher_name = announcement.author_name
  ) = 1;
