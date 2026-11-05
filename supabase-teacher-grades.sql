create table if not exists public.teacher_subject_grade_settings (
  subject_id uuid primary key references public.academic_subjects(id) on delete cascade,
  teacher_id uuid not null references public.teachers(id) on delete cascade,
  has_practical boolean not null default false,
  has_studies boolean not null default false,
  include_card boolean not null default true,
  include_activity boolean not null default true,
  include_theory_study boolean not null default false,
  include_practical_study boolean not null default false,
  include_theory_exam boolean not null default true,
  include_practical_exam boolean not null default false,
  max_card numeric(7, 2) not null default 10 check (max_card >= 0 and max_card <= 1000),
  max_activity numeric(7, 2) not null default 10 check (max_activity >= 0 and max_activity <= 1000),
  max_theory_study numeric(7, 2) not null default 0 check (max_theory_study >= 0 and max_theory_study <= 1000),
  max_practical_study numeric(7, 2) not null default 0 check (max_practical_study >= 0 and max_practical_study <= 1000),
  max_theory_exam numeric(7, 2) not null default 100 check (max_theory_exam >= 0 and max_theory_exam <= 1000),
  max_practical_exam numeric(7, 2) not null default 0 check (max_practical_exam >= 0 and max_practical_exam <= 1000),
  updated_at timestamptz not null default now()
);

alter table public.teacher_subject_grade_settings
  add column if not exists include_card boolean,
  add column if not exists include_activity boolean,
  add column if not exists include_theory_study boolean,
  add column if not exists include_practical_study boolean,
  add column if not exists include_theory_exam boolean,
  add column if not exists include_practical_exam boolean;

update public.teacher_subject_grade_settings
set include_card = coalesce(include_card, true),
    include_activity = coalesce(include_activity, true),
    include_theory_study = coalesce(include_theory_study, has_studies),
    include_practical_study = coalesce(include_practical_study, has_studies and has_practical),
    include_theory_exam = coalesce(include_theory_exam, true),
    include_practical_exam = coalesce(include_practical_exam, has_practical);

alter table public.teacher_subject_grade_settings
  alter column include_card set default true,
  alter column include_card set not null,
  alter column include_activity set default true,
  alter column include_activity set not null,
  alter column include_theory_study set default false,
  alter column include_theory_study set not null,
  alter column include_practical_study set default false,
  alter column include_practical_study set not null,
  alter column include_theory_exam set default true,
  alter column include_theory_exam set not null,
  alter column include_practical_exam set default false,
  alter column include_practical_exam set not null;

create table if not exists public.teacher_subject_grades (
  id bigint generated always as identity primary key,
  subject_id uuid not null references public.academic_subjects(id) on delete cascade,
  student_id text not null,
  component text not null check (component in (
    'card',
    'activity',
    'theoryStudy',
    'practicalStudy',
    'theoryExam',
    'practicalExam'
  )),
  score numeric(7, 2) not null check (score >= 0),
  max_score numeric(7, 2) not null check (max_score > 0),
  entered_by uuid not null references public.teachers(id) on delete cascade,
  updated_at timestamptz not null default now(),
  constraint teacher_subject_grades_score_max_check check (score <= max_score),
  constraint teacher_subject_grades_student_component_unique unique (subject_id, student_id, component)
);

create index if not exists teacher_subject_grades_student_subject_idx
  on public.teacher_subject_grades (student_id, subject_id);

alter table public.teacher_subject_grade_settings enable row level security;
alter table public.teacher_subject_grades enable row level security;
revoke all on public.teacher_subject_grade_settings from anon, authenticated;
revoke all on public.teacher_subject_grades from anon, authenticated;
grant all on public.teacher_subject_grade_settings to service_role;
grant all on public.teacher_subject_grades to service_role;
grant usage, select on sequence public.teacher_subject_grades_id_seq to service_role;
