create table if not exists public.teacher_inquiries (
  id uuid primary key default gen_random_uuid(),
  student_id text not null,
  student_name text not null,
  student_year text not null check (student_year in ('أولى', 'ثانية')),
  student_class text not null default '',
  subject text not null,
  status text not null default 'awaiting_teacher'
    check (status in ('awaiting_teacher', 'answered')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists teacher_inquiries_student_updated_idx
  on public.teacher_inquiries (student_id, updated_at desc);

create table if not exists public.teacher_inquiry_recipients (
  inquiry_id uuid not null references public.teacher_inquiries(id) on delete cascade,
  teacher_id uuid not null references public.teachers(id) on delete cascade,
  primary key (inquiry_id, teacher_id)
);

create index if not exists teacher_inquiry_recipients_teacher_idx
  on public.teacher_inquiry_recipients (teacher_id, inquiry_id);

create table if not exists public.teacher_inquiry_messages (
  id uuid primary key default gen_random_uuid(),
  inquiry_id uuid not null references public.teacher_inquiries(id) on delete cascade,
  sender_type text not null check (sender_type in ('student', 'teacher')),
  sender_id text not null,
  sender_name text not null,
  body text not null default '' check (char_length(body) <= 4000),
  attachment_path text,
  attachment_name text,
  attachment_type text,
  attachment_size bigint,
  created_at timestamptz not null default now(),
  constraint teacher_inquiry_message_content_check
    check (
      char_length(body) >= 3
      or attachment_path is not null
    )
);

create index if not exists teacher_inquiry_messages_inquiry_created_idx
  on public.teacher_inquiry_messages (inquiry_id, created_at);

alter table public.teacher_inquiries enable row level security;
alter table public.teacher_inquiry_recipients enable row level security;
alter table public.teacher_inquiry_messages enable row level security;

revoke all on public.teacher_inquiries from anon, authenticated;
revoke all on public.teacher_inquiry_recipients from anon, authenticated;
revoke all on public.teacher_inquiry_messages from anon, authenticated;

grant all on public.teacher_inquiries to service_role;
grant all on public.teacher_inquiry_recipients to service_role;
grant all on public.teacher_inquiry_messages to service_role;

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
