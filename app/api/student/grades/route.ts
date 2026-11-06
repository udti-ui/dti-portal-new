import { NextResponse } from 'next/server';
import { createSupabaseAdminClient } from '../../../../lib/supabaseAdmin';

export const dynamic = 'force-dynamic';

const clean = (value: unknown) => String(value ?? '').trim();
const normalizeYear = (value: unknown): 'أولى' | 'ثانية' | '' => {
  const year = clean(value).replace(/\s+/g, '').toLocaleLowerCase();
  if (['1', '١'].includes(year) || year.includes('اولى') || year.includes('أولى') || year.includes('first')) return 'أولى';
  if (['2', '٢'].includes(year) || year.includes('ثانية') || year.includes('second')) return 'ثانية';
  return '';
};
const componentLabels: Record<string, string> = {
  card: 'علامة البطاقة',
  activity: 'علامة النشاط',
  theoryStudy: 'مذاكرة نظرية',
  practicalStudy: 'مذاكرة عملية',
  theoryExam: 'امتحان نظري',
  practicalExam: 'امتحان عملي',
};

export async function POST(request: Request) {
  const supabase = createSupabaseAdminClient();
  if (!supabase) {
    return NextResponse.json({ success: false, error: 'student-portal-server-key-missing' }, { status: 503 });
  }

  try {
    const body = await request.json() as { studentId?: string; password?: string };
    const studentId = clean(body.studentId);
    const password = clean(body.password);
    if (!studentId || !password) {
      return NextResponse.json({ success: false, error: 'student-credentials-required' }, { status: 400 });
    }

    const { data: student, error: studentError } = await supabase.from('students').select('"كلمة السر", "السنه الدراسية"')
      .eq('الرقم الجامعي', studentId).maybeSingle();
    if (studentError) return NextResponse.json({ success: false, error: 'student-lookup-failed' }, { status: 500 });
    if (!student || clean(student['كلمة السر']) !== password) {
      return NextResponse.json({ success: false, error: 'student-credentials-invalid' }, { status: 401 });
    }

    const studentYear = normalizeYear(student['السنه الدراسية']);
    if (!studentYear) return NextResponse.json({ success: true, grades: [] });

    const { data: subjects, error: subjectsError } = await supabase.from('academic_subjects')
      .select('id, name, student_year')
      .eq('student_year', studentYear);
    if (subjectsError) {
      console.error('STUDENT_GRADES_SUBJECTS_LOAD_FAILED:', subjectsError.message);
      return NextResponse.json({ success: false, error: 'student-grades-load-failed' }, { status: 500 });
    }
    const subjectById = new Map((subjects ?? []).map((subject) => [String(subject.id), clean(subject.name)]));
    if (!subjectById.size) return NextResponse.json({ success: true, grades: [] });

    const subjectIds = [...subjectById.keys()];
    const [settingsResult, gradesResult] = await Promise.all([
      supabase.from('teacher_subject_grade_settings')
        .select('subject_id, include_card, include_activity, include_theory_study, include_practical_study, include_theory_exam, include_practical_exam')
        .in('subject_id', subjectIds),
      supabase.from('teacher_subject_grades')
        .select('id, subject_id, component, score, max_score, updated_at')
        .eq('student_id', studentId)
        .in('subject_id', subjectIds)
        .order('updated_at', { ascending: false }),
    ]);
    const error = settingsResult.error ?? gradesResult.error;
    if (error) {
      console.error('STUDENT_GRADES_LOAD_FAILED:', error.message);
      if (error.code === 'PGRST205' || /does not exist|relation|could not find the .*column/i.test(error.message)) {
        return NextResponse.json({ success: false, error: 'student-grades-schema-not-configured' }, { status: 503 });
      }
      return NextResponse.json({ success: false, error: 'student-grades-load-failed' }, { status: 500 });
    }

    const enabledComponentsBySubject = new Map((settingsResult.data ?? []).map((settings) => [
      String(settings.subject_id),
      new Set(Object.entries({
        card: settings.include_card,
        activity: settings.include_activity,
        theoryStudy: settings.include_theory_study,
        practicalStudy: settings.include_practical_study,
        theoryExam: settings.include_theory_exam,
        practicalExam: settings.include_practical_exam,
      }).filter(([, enabled]) => enabled === true).map(([component]) => component)),
    ]));
    const grades = (gradesResult.data ?? []).flatMap((grade) => {
      const subject = subjectById.get(String(grade.subject_id));
      const component = String(grade.component);
      const label = componentLabels[component];
      if (!subject || !label || !enabledComponentsBySubject.get(String(grade.subject_id))?.has(component)) return [];
      return [{
        id: String(grade.id),
        subject,
        component,
        componentLabel: label,
        score: Number(grade.score),
        maxScore: Number(grade.max_score),
        updatedAt: String(grade.updated_at),
      }];
    });
    return NextResponse.json({ success: true, grades });
  } catch (error) {
    console.error('STUDENT_GRADES_REQUEST_FAILED:', error);
    return NextResponse.json({ success: false, error: 'student-grades-load-failed' }, { status: 500 });
  }
}
