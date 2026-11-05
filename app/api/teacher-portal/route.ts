import { randomBytes, scryptSync, timingSafeEqual } from 'crypto';
import { NextResponse } from 'next/server';
import { createSupabaseAdminClient } from '../../../lib/supabaseAdmin';
import { notifyStudentsAboutAnnouncement } from '../../../lib/announcementNotifications';
import { removeAnnouncementAttachment, uploadAnnouncementAttachment } from '../../../lib/announcementAttachments';
import { getInquiryMessages } from '../../../lib/teacherInquiryMessages';
import { escapeTelegramHtml, sendTelegramNotification } from '../../../lib/telegram';

export const dynamic = 'force-dynamic';

type TeacherRow = {
  id: string;
  teacher_name: string;
  subjects: unknown;
  is_active: boolean;
  login_username?: string | null;
  password_hash?: string | null;
  telegram_chat_id?: string | null;
};

type TeacherPortalRequest = {
  action?: string;
  username?: string;
  password?: string;
  supervisorUsername?: string;
  supervisorPassword?: string;
  teacherId?: string;
  teacherName?: string;
  loginUsername?: string;
  newPassword?: string;
  telegramChatId?: string;
  isActive?: boolean;
  studentId?: string;
  subject?: string;
  message?: string;
  title?: string;
  content?: string;
  attachment?: File;
  alertId?: number;
  announcementId?: number | string;
  inquiryId?: string;
  gradeSettings?: unknown;
  gradeComponent?: string;
  gradeScore?: number;
  gradeEntries?: unknown;
  gradeBatches?: unknown;
  gradeDeleteScope?: string;
};

const clean = (value: unknown) => String(value ?? '').trim();
const normalized = (value: unknown) => clean(value).replace(/\s+/g, '').toLocaleLowerCase();
const errorResponse = (error: string, status: number) => NextResponse.json({ success: false, error }, { status });
const normalizeYear = (value: unknown): 'أولى' | 'ثانية' | '' => {
  const year = clean(value).replace(/\s+/g, '').toLocaleLowerCase();
  if (['1', '١'].includes(year) || year.includes('اولى') || year.includes('أولى') || year.includes('first')) return 'أولى';
  if (['2', '٢'].includes(year) || year.includes('ثانية') || year.includes('second')) return 'ثانية';
  return '';
};
const getAssignmentLabel = (name: string, year: string) => `${name} · ${year}`;

const hashPassword = (password: string) => {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
};

const verifyPassword = (password: string, storedHash: string) => {
  const [salt, hash] = storedHash.split(':');
  if (!salt || !hash || !/^[a-f\d]{128}$/i.test(hash)) return false;
  const actualHash = scryptSync(password, salt, 64);
  return timingSafeEqual(actualHash, Buffer.from(hash, 'hex'));
};

const getTeacher = async (supabase: NonNullable<ReturnType<typeof createSupabaseAdminClient>>, username: string, password: string) => {
  const { data, error } = await supabase
    .from('teachers')
    .select('id, teacher_name, subjects, is_active, login_username, password_hash, telegram_chat_id')
    .eq('login_username', normalized(username))
    .maybeSingle();
  if (error) throw error;

  const teacher = data as TeacherRow | null;
  if (!teacher || teacher.is_active !== true || !teacher.password_hash || !verifyPassword(password, teacher.password_hash)) {
    return null;
  }
  return teacher;
};

const verifySupervisor = async (
  supabase: NonNullable<ReturnType<typeof createSupabaseAdminClient>>,
  username: string,
  password: string
) => {
  const { data, error } = await supabase.from('المشرفين').select('*');
  if (error) throw error;
  const supervisor = (Array.isArray(data) ? data : []).find((row) => {
    const record = row as Record<string, unknown>;
    return normalized(record['اسم المستخدم'] ?? record.username ?? record['اسم_المستخدم'] ?? record.user_name) === normalized(username)
      && clean(record['كلمة المرور'] ?? record['كلمة السر'] ?? record['كلمة_المرور'] ?? record.password ?? record.pass) === password;
  }) as Record<string, unknown> | undefined;
  if (!supervisor) return false;
  const degree = normalized(supervisor['الدرجة'] ?? supervisor.degree ?? supervisor.rank ?? supervisor.role ?? supervisor.level);
  return ['1', '١', 'one', 'first', 'اولى', 'الأولى', '1st', 'moderator', 'مودرييتور', 'monitor', 'مراقب', 'المودرييتور']
    .some((value) => degree.includes(normalized(value)));
};

const getStudentName = (student: Record<string, unknown>) => [
  student['اسم الطالب'] ?? student.name ?? student.student_name,
  student['اسم الاب'] ?? student['اسم الأب'] ?? student.father_name,
  student['الكنية'] ?? student.family_name ?? student.surname,
].map(clean).filter((part) => part && part !== '.').join(' ');

const getStudentYear = (student: Record<string, unknown>) => normalizeYear(
  student['السنه الدراسية'] ?? student['السنة الدراسية'] ?? student.year ?? student.student_year
);
const attendanceKey = (studentId: string, subject: string, date: string) => [
  studentId,
  normalized(subject),
  date.slice(0, 10),
].join('|');

const gradeComponents = {
  card: { label: 'علامة البطاقة', ceiling: 'max_card', included: 'include_card' },
  activity: { label: 'علامة النشاط', ceiling: 'max_activity', included: 'include_activity' },
  theoryStudy: { label: 'مذاكرة نظرية', ceiling: 'max_theory_study', included: 'include_theory_study' },
  practicalStudy: { label: 'مذاكرة عملية', ceiling: 'max_practical_study', included: 'include_practical_study' },
  theoryExam: { label: 'امتحان نظري', ceiling: 'max_theory_exam', included: 'include_theory_exam' },
  practicalExam: { label: 'امتحان عملي', ceiling: 'max_practical_exam', included: 'include_practical_exam' },
} as const;
type GradeComponent = keyof typeof gradeComponents;
type GradeSettings = {
  include_card: boolean;
  include_activity: boolean;
  include_theory_study: boolean;
  include_practical_study: boolean;
  include_theory_exam: boolean;
  include_practical_exam: boolean;
  max_card: number;
  max_activity: number;
  max_theory_study: number;
  max_practical_study: number;
  max_theory_exam: number;
  max_practical_exam: number;
};

const parseGradeSettings = (value: unknown): GradeSettings | null => {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (typeof record.includeCard !== 'boolean'
    || typeof record.includeActivity !== 'boolean'
    || typeof record.includeTheoryStudy !== 'boolean'
    || typeof record.includePracticalStudy !== 'boolean'
    || typeof record.includeTheoryExam !== 'boolean'
    || typeof record.includePracticalExam !== 'boolean') return null;
  const included = {
    include_card: record.includeCard,
    include_activity: record.includeActivity,
    include_theory_study: record.includeTheoryStudy,
    include_practical_study: record.includePracticalStudy,
    include_theory_exam: record.includeTheoryExam,
    include_practical_exam: record.includePracticalExam,
  };
  const ceilings = {
    max_card: Number(record.maxCard),
    max_activity: Number(record.maxActivity),
    max_theory_study: Number(record.maxTheoryStudy),
    max_practical_study: Number(record.maxPracticalStudy),
    max_theory_exam: Number(record.maxTheoryExam),
    max_practical_exam: Number(record.maxPracticalExam),
  };
  if (Object.values(ceilings).some((ceiling) => !Number.isFinite(ceiling) || ceiling < 0 || ceiling > 1000)
    || Object.entries(included).some(([key, enabled]) => enabled && ceilings[key.replace('include_', 'max_') as keyof typeof ceilings] <= 0)) {
    return null;
  }
  return { ...included, ...ceilings };
};

export async function POST(request: Request) {
  const supabase = createSupabaseAdminClient();
  if (!supabase) return errorResponse('teacher-portal-server-key-missing', 503);

  try {
    let body: TeacherPortalRequest;
    if ((request.headers.get('content-type') ?? '').includes('multipart/form-data')) {
      const formData = await request.formData();
      body = Object.fromEntries(formData.entries()) as TeacherPortalRequest;
    } else {
      body = await request.json() as TeacherPortalRequest;
    }

    if (body.action === 'student-alerts') {
      const studentId = clean(body.studentId);
      const password = clean(body.password);
      if (!studentId || !password) return errorResponse('student-credentials-required', 400);
      const { data: student, error: studentError } = await supabase
        .from('students')
        .select('*')
        .eq('الرقم الجامعي', studentId)
        .maybeSingle();
      if (studentError) return errorResponse('student-verification-failed', 500);
      if (!student || clean(student['كلمة السر'] ?? student.password ?? student.pass) !== password) {
        return errorResponse('student-credentials-invalid', 401);
      }

      const { data: alerts, error } = await supabase
        .from('teacher_alerts')
        .select('id, student_id, teacher_name, subject, message, created_at')
        .eq('student_id', studentId)
        .order('created_at', { ascending: false });
      if (error) return errorResponse('teacher-alerts-load-failed', 500);

      return NextResponse.json({
        success: true,
        alerts: (alerts ?? []).map((alert) => ({
          warning_id: alert.id,
          'الرقم الجامعي': alert.student_id,
          'اسم الطالب': getStudentName(student as Record<string, unknown>),
          'نوع الإنذار': 'تنبيه من المدرس',
          'السبب': `تنبيه في مادة ${alert.subject}`,
          'التفاصيل': alert.message,
          'التاريخ': alert.created_at,
          'مصدر التنبيه': 'teacher',
          'اسم المدرس': alert.teacher_name,
        })),
      });
    }

    if (body.action === 'list-accounts' || body.action === 'set-account') {
      const supervisorUsername = clean(body.supervisorUsername);
      const supervisorPassword = clean(body.supervisorPassword);
      if (!supervisorUsername || !supervisorPassword) return errorResponse('supervisor-credentials-required', 400);
      if (!await verifySupervisor(supabase, supervisorUsername, supervisorPassword)) {
        return errorResponse('supervisor-credentials-invalid', 401);
      }

      if (body.action === 'list-accounts') {
        const { data, error } = await supabase
          .from('teachers')
          .select('id, teacher_name, subjects, is_active, login_username')
          .order('teacher_name');
        if (error) return errorResponse('teacher-accounts-load-failed', 500);
        return NextResponse.json({ success: true, teachers: data ?? [] });
      }

      const teacherId = clean(body.teacherId);
      const teacherName = clean(body.teacherName);
      const loginUsername = normalized(body.loginUsername);
      const newPassword = clean(body.newPassword);
      const isCreatingTeacher = !teacherId;
      if (!teacherName || teacherName.length > 160
        || !/^[\p{L}\p{N}_.-]{3,80}$/u.test(loginUsername)
        || (isCreatingTeacher && newPassword.length < 8)
        || (newPassword && newPassword.length < 8)) {
        return errorResponse('invalid-teacher-account', 400);
      }
      const accountPayload: Record<string, unknown> = {
        teacher_name: teacherName,
        login_username: loginUsername,
        is_active: body.isActive !== false,
      };
      if (newPassword) accountPayload.password_hash = hashPassword(newPassword);
      const { data, error } = isCreatingTeacher
        ? await supabase.from('teachers')
          .insert({ ...accountPayload, subjects: [] })
          .select('id, teacher_name, subjects, is_active, login_username')
          .single()
        : await supabase.from('teachers')
          .update(accountPayload)
          .eq('id', teacherId)
          .select('id, teacher_name, subjects, is_active, login_username')
          .maybeSingle();
      if (error) return errorResponse('teacher-account-save-failed', 500);
      if (!data) return errorResponse('teacher-not-found', 404);
      return NextResponse.json({ success: true, teacher: data });
    }

    const username = clean(body.username);
    const password = clean(body.password);
    if (!username || !password) return errorResponse('teacher-credentials-required', 400);
    const teacher = await getTeacher(supabase, username, password);
    if (!teacher) return errorResponse('teacher-credentials-invalid', 401);

    if (body.action === 'update-profile') {
      const telegramChatId = clean(body.telegramChatId);
      const newPassword = typeof body.newPassword === 'string' ? body.newPassword.trim() : '';
      if ((telegramChatId && (!/^-?\d{1,20}$/.test(telegramChatId) || telegramChatId === '-'))
        || (newPassword && newPassword.length < 8)) {
        return errorResponse('invalid-teacher-profile', 400);
      }

      const updatePayload: Record<string, unknown> = {
        telegram_chat_id: telegramChatId || null,
      };
      if (newPassword) updatePayload.password_hash = hashPassword(newPassword);
      const { error } = await supabase.from('teachers').update(updatePayload).eq('id', teacher.id);
      if (error) {
        console.error('TEACHER_PROFILE_UPDATE_FAILED:', error.message);
        return errorResponse('teacher-profile-update-failed', 500);
      }
      return NextResponse.json({
        success: true,
        teacher: { id: teacher.id, name: teacher.teacher_name, telegramChatId: telegramChatId || '' },
      });
    }

    const { data: assignedSubjects, error: assignedSubjectsError } = await supabase
      .from('academic_subjects')
      .select('id, name, student_year')
      .eq('teacher_id', teacher.id)
      .order('student_year')
      .order('name');
    if (assignedSubjectsError) return errorResponse('teacher-subjects-load-failed', 500);
    const assignments = (assignedSubjects ?? []).flatMap((row) => {
      const name = clean(row.name);
      const year = normalizeYear(row.student_year);
      return name && year ? [{ id: String(row.id), name, year, label: getAssignmentLabel(name, year) }] : [];
    });
    const assignmentLabels = assignments.map((assignment) => assignment.label);

    if (body.action === 'list-grades') {
      const subjectIds = assignments.map((assignment) => assignment.id);
      if (!subjectIds.length) return NextResponse.json({ success: true, settings: [], grades: [] });
      const [settingsResult, gradesResult] = await Promise.all([
        supabase.from('teacher_subject_grade_settings').select('*').in('subject_id', subjectIds),
        supabase.from('teacher_subject_grades')
          .select('id, subject_id, student_id, component, score, max_score, updated_at')
          .in('subject_id', subjectIds)
          .order('updated_at', { ascending: false }),
      ]);
      if (settingsResult.error || gradesResult.error) {
        const error = settingsResult.error ?? gradesResult.error;
        console.error('TEACHER_GRADES_LOAD_FAILED:', error?.message);
        if (error?.code === 'PGRST205' || /does not exist|relation|could not find the .*column/i.test(error?.message ?? '')) {
          return errorResponse('teacher-grades-schema-not-configured', 503);
        }
        return errorResponse('teacher-grades-load-failed', 500);
      }
      const subjectLabels = new Map(assignments.map((assignment) => [assignment.id, assignment.label]));
      const enabledComponentsBySubject = new Map((settingsResult.data ?? []).map((settings) => [
        String(settings.subject_id),
        new Set((Object.entries(gradeComponents) as Array<[GradeComponent, (typeof gradeComponents)[GradeComponent]]>)
          .filter(([, component]) => settings[component.included] === true)
          .map(([component]) => component)),
      ]));
      return NextResponse.json({
        success: true,
        settings: (settingsResult.data ?? []).map((settings) => ({
          ...settings,
          subject: subjectLabels.get(String(settings.subject_id)) ?? '',
        })),
        grades: (gradesResult.data ?? []).map((grade) => ({
          ...grade,
          subject: subjectLabels.get(String(grade.subject_id)) ?? '',
        })).filter((grade) => grade.subject
          && enabledComponentsBySubject.get(String(grade.subject_id))?.has(grade.component as GradeComponent)),
      });
    }

    if (body.action === 'save-grade-settings') {
      const assignment = assignments.find((item) => item.label === clean(body.subject));
      const settings = parseGradeSettings(body.gradeSettings);
      if (!assignment || !settings) return errorResponse('invalid-grade-settings', 400);
      const { error } = await supabase.from('teacher_subject_grade_settings').upsert({
        subject_id: assignment.id,
        teacher_id: teacher.id,
        ...settings,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'subject_id' });
      if (error) {
        console.error('TEACHER_GRADE_SETTINGS_SAVE_FAILED:', error.message);
        return errorResponse('teacher-grade-settings-save-failed', 500);
      }
      return NextResponse.json({ success: true, settings: { subject_id: assignment.id, ...settings } });
    }

    if (body.action === 'save-grade') {
      const assignment = assignments.find((item) => item.label === clean(body.subject));
      const studentId = clean(body.studentId);
      const requestedComponent = clean(body.gradeComponent);
      const component = Object.prototype.hasOwnProperty.call(gradeComponents, requestedComponent)
        ? requestedComponent as GradeComponent
        : null;
      const componentInfo = component ? gradeComponents[component] : null;
      const score = body.gradeScore;
      if (!assignment || !studentId || !componentInfo || typeof score !== 'number' || !Number.isFinite(score) || score < 0) {
        return errorResponse('invalid-grade', 400);
      }
      const { data: student, error: studentError } = await supabase.from('students').select('*')
        .eq('الرقم الجامعي', studentId).maybeSingle();
      if (studentError) return errorResponse('student-lookup-failed', 500);
      if (!student) return errorResponse('student-not-found', 404);
      if (getStudentYear(student as Record<string, unknown>) !== assignment.year) {
        return errorResponse('student-year-mismatch', 403);
      }

      const { data: settings, error: settingsError } = await supabase.from('teacher_subject_grade_settings')
        .select('*').eq('subject_id', assignment.id).maybeSingle();
      if (settingsError) {
        console.error('TEACHER_GRADE_SETTINGS_LOAD_FAILED:', settingsError.message);
        return errorResponse('teacher-grade-settings-load-failed', 500);
      }
      if (!settings) return errorResponse('teacher-grade-settings-required', 409);

      const allowed = settings[componentInfo.included] === true;
      const maxScore = Number(settings[componentInfo.ceiling]);
      if (!allowed || !Number.isFinite(maxScore) || maxScore <= 0) return errorResponse('grade-component-disabled', 400);
      if (score > maxScore) return errorResponse('grade-exceeds-maximum', 400);

      const { data, error } = await supabase.from('teacher_subject_grades').upsert({
        subject_id: assignment.id,
        student_id: studentId,
        component,
        score,
        max_score: maxScore,
        entered_by: teacher.id,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'subject_id,student_id,component' })
        .select('id, subject_id, student_id, component, score, max_score, updated_at')
        .single();
      if (error) {
        console.error('TEACHER_GRADE_SAVE_FAILED:', error.message);
        return errorResponse('teacher-grade-save-failed', 500);
      }
      return NextResponse.json({ success: true, grade: data });
    }

    if (body.action === 'bulk-save-grades') {
      const assignment = assignments.find((item) => item.label === clean(body.subject));
      const requestedComponent = clean(body.gradeComponent);
      const component = Object.prototype.hasOwnProperty.call(gradeComponents, requestedComponent)
        ? requestedComponent as GradeComponent
        : null;
      const componentInfo = component ? gradeComponents[component] : null;
      if (!assignment || !componentInfo || !Array.isArray(body.gradeEntries) || body.gradeEntries.length > 1000) {
        return errorResponse('invalid-grade-import', 400);
      }

      const { data: settings, error: settingsError } = await supabase.from('teacher_subject_grade_settings')
        .select('*').eq('subject_id', assignment.id).maybeSingle();
      if (settingsError) {
        console.error('TEACHER_GRADE_SETTINGS_LOAD_FAILED:', settingsError.message);
        return errorResponse('teacher-grade-settings-load-failed', 500);
      }
      if (!settings) return errorResponse('teacher-grade-settings-required', 409);

      const allowed = settings[componentInfo.included] === true;
      const maxScore = Number(settings[componentInfo.ceiling]);
      if (!allowed || !Number.isFinite(maxScore) || maxScore <= 0) {
        return errorResponse('grade-component-disabled', 400);
      }

      const entries = body.gradeEntries.flatMap((entry) => {
        if (!entry || typeof entry !== 'object') return [];
        const record = entry as Record<string, unknown>;
        const studentId = clean(record.studentId);
        const score = record.score;
        if (!studentId || typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > maxScore) return [];
        return [{ studentId, score }];
      });
      if (entries.length !== body.gradeEntries.length || new Set(entries.map((entry) => entry.studentId)).size !== entries.length) {
        return errorResponse('invalid-grade-import', 400);
      }
      if (!entries.length) return NextResponse.json({ success: true, grades: [] });

      const studentIds = entries.map((entry) => entry.studentId);
      const { data: matchingStudents, error: studentsError } = await supabase.from('students').select('*')
        .in('الرقم الجامعي', studentIds);
      if (studentsError) {
        console.error('TEACHER_GRADE_IMPORT_STUDENTS_LOAD_FAILED:', studentsError.message);
        return errorResponse('student-lookup-failed', 500);
      }
      const matchingIds = new Set((matchingStudents ?? [])
        .filter((student) => getStudentYear(student as Record<string, unknown>) === assignment.year)
        .map((student) => clean((student as Record<string, unknown>)['الرقم الجامعي'])));
      const unmatchedIds = studentIds.filter((studentId) => !matchingIds.has(studentId));
      if (unmatchedIds.length) {
        return NextResponse.json({ success: false, error: 'grade-import-students-unmatched', unmatchedIds }, { status: 400 });
      }

      const { data, error } = await supabase.from('teacher_subject_grades').upsert(entries.map((entry) => ({
        subject_id: assignment.id,
        student_id: entry.studentId,
        component,
        score: entry.score,
        max_score: maxScore,
        entered_by: teacher.id,
        updated_at: new Date().toISOString(),
      })), { onConflict: 'subject_id,student_id,component' })
        .select('id, subject_id, student_id, component, score, max_score, updated_at');
      if (error) {
        console.error('TEACHER_GRADE_BULK_SAVE_FAILED:', error.message);
        return errorResponse('teacher-grade-save-failed', 500);
      }
      return NextResponse.json({
        success: true,
        grades: (data ?? []).map((grade) => ({ ...grade, subject: assignment.label })),
      });
    }

    if (body.action === 'bulk-save-grade-sheet') {
      const assignment = assignments.find((item) => item.label === clean(body.subject));
      if (!assignment || !Array.isArray(body.gradeBatches) || body.gradeBatches.length > Object.keys(gradeComponents).length) {
        return errorResponse('invalid-grade-import', 400);
      }

      const { data: settings, error: settingsError } = await supabase.from('teacher_subject_grade_settings')
        .select('*').eq('subject_id', assignment.id).maybeSingle();
      if (settingsError) {
        console.error('TEACHER_GRADE_SETTINGS_LOAD_FAILED:', settingsError.message);
        return errorResponse('teacher-grade-settings-load-failed', 500);
      }
      if (!settings) return errorResponse('teacher-grade-settings-required', 409);

      const gradeRows: Array<{
        subject_id: string;
        student_id: string;
        component: GradeComponent;
        score: number;
        max_score: number;
        entered_by: string;
        updated_at: string;
      }> = [];
      const studentIds = new Set<string>();
      const seenComponents = new Set<GradeComponent>();
      for (const batch of body.gradeBatches) {
        if (!batch || typeof batch !== 'object') return errorResponse('invalid-grade-import', 400);
        const record = batch as Record<string, unknown>;
        const requestedComponent = clean(record.component);
        const component = Object.prototype.hasOwnProperty.call(gradeComponents, requestedComponent)
          ? requestedComponent as GradeComponent
          : null;
        const componentInfo = component ? gradeComponents[component] : null;
        if (!component || !componentInfo || seenComponents.has(component) || !Array.isArray(record.entries) || record.entries.length > 1000) {
          return errorResponse('invalid-grade-import', 400);
        }
        seenComponents.add(component);

        const allowed = settings[componentInfo.included] === true;
        const maxScore = Number(settings[componentInfo.ceiling]);
        if (!allowed || !Number.isFinite(maxScore) || maxScore <= 0) return errorResponse('grade-component-disabled', 400);

        const seenStudents = new Set<string>();
        for (const entry of record.entries) {
          if (!entry || typeof entry !== 'object') return errorResponse('invalid-grade-import', 400);
          const grade = entry as Record<string, unknown>;
          const studentId = clean(grade.studentId);
          const score = grade.score;
          if (!studentId || seenStudents.has(studentId) || typeof score !== 'number'
            || !Number.isFinite(score) || score < 0 || score > maxScore) {
            return errorResponse('invalid-grade-import', 400);
          }
          seenStudents.add(studentId);
          studentIds.add(studentId);
          gradeRows.push({
            subject_id: assignment.id,
            student_id: studentId,
            component,
            score,
            max_score: maxScore,
            entered_by: teacher.id,
            updated_at: new Date().toISOString(),
          });
        }
      }
      if (gradeRows.length > 6000) return errorResponse('invalid-grade-import', 400);
      if (!gradeRows.length) return NextResponse.json({ success: true, grades: [] });

      const { data: matchingStudents, error: studentsError } = await supabase.from('students').select('*')
        .in('الرقم الجامعي', [...studentIds]);
      if (studentsError) {
        console.error('TEACHER_GRADE_IMPORT_STUDENTS_LOAD_FAILED:', studentsError.message);
        return errorResponse('student-lookup-failed', 500);
      }
      const matchingIds = new Set((matchingStudents ?? [])
        .filter((student) => getStudentYear(student as Record<string, unknown>) === assignment.year)
        .map((student) => clean((student as Record<string, unknown>)['الرقم الجامعي'])));
      const unmatchedIds = [...studentIds].filter((studentId) => !matchingIds.has(studentId));
      if (unmatchedIds.length) {
        return NextResponse.json({ success: false, error: 'grade-import-students-unmatched', unmatchedIds }, { status: 400 });
      }

      const { data, error } = await supabase.from('teacher_subject_grades').upsert(gradeRows, {
        onConflict: 'subject_id,student_id,component',
      }).select('id, subject_id, student_id, component, score, max_score, updated_at');
      if (error) {
        console.error('TEACHER_GRADE_SHEET_SAVE_FAILED:', error.message);
        return errorResponse('teacher-grade-save-failed', 500);
      }
      return NextResponse.json({
        success: true,
        grades: (data ?? []).map((grade) => ({ ...grade, subject: assignment.label })),
      });
    }

    if (body.action === 'delete-grade' || body.action === 'delete-grades') {
      const assignment = assignments.find((item) => item.label === clean(body.subject));
      const requestedComponent = clean(body.gradeComponent);
      const component = Object.prototype.hasOwnProperty.call(gradeComponents, requestedComponent)
        ? requestedComponent as GradeComponent
        : null;
      if (!assignment) return errorResponse('invalid-grade-delete', 400);

      let deletion = supabase.from('teacher_subject_grades').delete()
        .eq('subject_id', assignment.id);
      if (body.action === 'delete-grade') {
        const studentId = clean(body.studentId);
        if (!component || !studentId) return errorResponse('invalid-grade-delete', 400);
        deletion = deletion.eq('student_id', studentId).eq('component', component);
      } else if (body.gradeDeleteScope === 'component' && component) {
        deletion = deletion.eq('component', component);
      } else if (body.gradeDeleteScope !== 'subject') {
        return errorResponse('invalid-grade-delete', 400);
      }

      const { data, error } = await deletion.select('id');
      if (error) {
        console.error('TEACHER_GRADE_DELETE_FAILED:', error.message);
        return errorResponse('teacher-grade-delete-failed', 500);
      }
      return NextResponse.json({ success: true, deletedCount: data?.length ?? 0 });
    }

    if (body.action === 'list-inquiries') {
      const { data: recipientRows, error: recipientsError } = await supabase.from('teacher_inquiry_recipients')
        .select('inquiry_id')
        .eq('teacher_id', teacher.id);
      if (recipientsError) {
        console.error('TEACHER_INQUIRY_RECIPIENTS_LOAD_FAILED:', recipientsError.message);
        return errorResponse('teacher-inquiries-load-failed', 500);
      }
      const inquiryIds = [...new Set((recipientRows ?? []).map((row) => String(row.inquiry_id)))];
      if (!inquiryIds.length) return NextResponse.json({ success: true, inquiries: [] });

      const { data: inquiries, error: inquiriesError } = await supabase.from('teacher_inquiries')
        .select('id, student_id, student_name, student_year, student_class, subject, status, created_at, updated_at')
        .in('id', inquiryIds)
        .order('updated_at', { ascending: false });
      if (inquiriesError) {
        console.error('TEACHER_INQUIRIES_LOAD_FAILED:', inquiriesError.message);
        return errorResponse('teacher-inquiries-load-failed', 500);
      }
      const messages = await getInquiryMessages(supabase, (inquiries ?? []).map((inquiry) => String(inquiry.id)));
      return NextResponse.json({
        success: true,
        inquiries: (inquiries ?? []).map((inquiry) => ({
          ...inquiry,
          id: String(inquiry.id),
          messages: messages.filter((message) => message.inquiry_id === String(inquiry.id)),
        })),
      });
    }

    if (body.action === 'reply-inquiry') {
      const inquiryId = clean(body.inquiryId);
      const message = clean(body.message);
      if (!inquiryId || message.length < 3 || message.length > 4000) {
        return errorResponse('invalid-inquiry-reply', 400);
      }
      const { data: recipient, error: recipientError } = await supabase.from('teacher_inquiry_recipients')
        .select('inquiry_id')
        .eq('inquiry_id', inquiryId)
        .eq('teacher_id', teacher.id)
        .maybeSingle();
      if (recipientError) return errorResponse('teacher-inquiry-reply-failed', 500);
      if (!recipient) return errorResponse('teacher-inquiry-not-found', 404);

      const { data: inquiry, error: inquiryError } = await supabase.from('teacher_inquiries')
        .select('id, student_id, student_name, subject')
        .eq('id', inquiryId)
        .maybeSingle();
      if (inquiryError) return errorResponse('teacher-inquiry-reply-failed', 500);
      if (!inquiry) return errorResponse('teacher-inquiry-not-found', 404);

      const { error: messageError } = await supabase.from('teacher_inquiry_messages').insert({
        inquiry_id: inquiryId,
        sender_type: 'teacher',
        sender_id: teacher.id,
        sender_name: teacher.teacher_name,
        body: message,
      });
      if (messageError) {
        console.error('TEACHER_INQUIRY_REPLY_SAVE_FAILED:', messageError.message);
        return errorResponse('teacher-inquiry-reply-failed', 500);
      }

      const { error: inquiryUpdateError } = await supabase.from('teacher_inquiries').update({
        status: 'answered',
        updated_at: new Date().toISOString(),
      }).eq('id', inquiryId);
      if (inquiryUpdateError) {
        console.error('TEACHER_INQUIRY_UPDATE_FAILED:', inquiryUpdateError.message);
        return errorResponse('teacher-inquiry-reply-failed', 500);
      }

      const { data: student, error: studentError } = await supabase.from('students')
        .select('telegram_chat_id, telegram_notifications_enabled')
        .eq('الرقم الجامعي', inquiry.student_id)
        .maybeSingle();
      let telegramSent = false;
      if (studentError) {
        console.error('TEACHER_INQUIRY_STUDENT_LOOKUP_FAILED:', studentError.message);
      } else {
        const telegramEnabled = student?.telegram_notifications_enabled === true
          || ['true', '1', 'yes'].includes(String(student?.telegram_notifications_enabled ?? '').toLowerCase());
        const chatId = clean(student?.telegram_chat_id);
        if (telegramEnabled && chatId) {
          const result = await sendTelegramNotification([
            '💬 <b>لديك رد جديد من المدرس</b>',
            '━━━━━━━━━━━━━━━━━━',
            `👨‍🏫 <b>المدرس:</b> ${escapeTelegramHtml(teacher.teacher_name)}`,
            `📖 <b>المادة:</b> ${escapeTelegramHtml(inquiry.subject)}`,
            `📝 <b>الرد:</b> ${escapeTelegramHtml(message.slice(0, 900))}`,
          ].join('\n'), { chatId, enabled: true });
          telegramSent = result?.ok === true;
          if (!telegramSent) {
            console.error('TEACHER_INQUIRY_REPLY_TELEGRAM_FAILED:', {
              inquiryId,
              status: result?.status,
            });
          }
        }
      }

      return NextResponse.json({ success: true, telegramSent });
    }

    if (body.action === 'login') {
      return NextResponse.json({
        success: true,
        teacher: {
          id: teacher.id,
          name: teacher.teacher_name,
          subjects: assignmentLabels,
          telegramChatId: clean(teacher.telegram_chat_id),
        },
      });
    }

    if (body.action === 'list-announcements') {
      const { data: announcements, error } = await supabase.from('announcements')
        .select('id, title, content, subject, student_year, target_scope, author_type, author_name, created_at, attachment_name, attachment_type, attachment_size')
        .eq('author_teacher_id', teacher.id)
        .order('created_at', { ascending: false })
        .limit(200);
      if (error) {
        console.error('TEACHER_ANNOUNCEMENTS_LOAD_FAILED:', error.message);
        if (error.code === 'PGRST205' || /announcements.*does not exist|could not find the .*column/i.test(error.message)) {
          return errorResponse('announcement-schema-not-configured', 503);
        }
        return errorResponse('announcements-load-failed', 500);
      }
      return NextResponse.json({ success: true, announcements: announcements ?? [] });
    }

    if (body.action === 'delete-announcement') {
      const announcementId = Number(body.announcementId);
      if (!Number.isSafeInteger(announcementId) || announcementId <= 0) {
        return errorResponse('invalid-announcement-id', 400);
      }
      const { data: announcement, error } = await supabase.from('announcements')
        .delete()
        .eq('id', announcementId)
        .eq('author_teacher_id', teacher.id)
        .select('id, attachment_path')
        .maybeSingle();
      if (error) {
        console.error('TEACHER_ANNOUNCEMENT_DELETE_FAILED:', error.message);
        return errorResponse('announcement-delete-failed', 500);
      }
      if (!announcement) return errorResponse('announcement-not-found', 404);
      if (announcement.attachment_path) {
        await removeAnnouncementAttachment(supabase, String(announcement.attachment_path));
      }
      return NextResponse.json({ success: true });
    }

    if (body.action === 'create-announcement') {
      const assignmentLabel = clean(body.subject);
      const assignment = assignments.find((item) => item.label === assignmentLabel);
      const title = clean(body.title);
      const content = clean(body.content);
      const attachment = body.attachment instanceof File ? body.attachment : null;
      if (!assignment || title.length < 3 || title.length > 160 || content.length > 4000
        || (!content && !attachment) || (content.length > 0 && content.length < 3 && !attachment)) {
        return errorResponse('invalid-teacher-announcement', 400);
      }
      const upload = await uploadAnnouncementAttachment(supabase, attachment);
      if (upload.error) {
        return errorResponse(upload.error, upload.error === 'announcement-attachment-invalid' ? 400 : 500);
      }
      const { data: announcement, error } = await supabase.from('announcements').insert({
        title,
        content,
        subject: assignment.name,
        student_year: assignment.year,
        target_scope: 'year',
        author_type: 'teacher',
        author_name: teacher.teacher_name,
        author_teacher_id: teacher.id,
        ...upload.attachment,
      }).select('id, title, content, subject, student_year, target_scope, author_type, author_name, created_at, attachment_name, attachment_type, attachment_size').single();
      if (error) {
        if (upload.attachment) await removeAnnouncementAttachment(supabase, upload.attachment.attachment_path);
        console.error('TEACHER_ANNOUNCEMENT_SAVE_FAILED:', error.message);
        if (error.code === 'PGRST205' || /announcements.*does not exist|could not find the .*column/i.test(error.message)) {
          return errorResponse('announcement-schema-not-configured', 503);
        }
        return errorResponse('announcement-save-failed', 500);
      }
      const notification = await notifyStudentsAboutAnnouncement(supabase, announcement);
      return NextResponse.json({ success: true, announcement, notification });
    }

    if (body.action === 'dashboard') {
      const [studentsResult, attendanceResult, warningsResult, alertsResult] = await Promise.all([
        supabase.from('students').select('*'),
        supabase.from('الحضور').select('*'),
        supabase.from('الإنذارات').select('*'),
        supabase.from('teacher_alerts')
          .select('id, student_id, subject, student_year, message, created_at')
          .eq('teacher_id', teacher.id)
          .order('created_at', { ascending: false }),
      ]);
      const warningsTableMissing = warningsResult.error
        && (warningsResult.error.code === 'PGRST205'
          || /does not exist|relation|not found/i.test(warningsResult.error.message));
      if (studentsResult.error || attendanceResult.error || alertsResult.error || (warningsResult.error && !warningsTableMissing)) {
        return errorResponse('teacher-dashboard-load-failed', 500);
      }
      const students = (studentsResult.data ?? []).map((row) => {
        const student = row as Record<string, unknown>;
        return {
          id: clean(student['الرقم الجامعي'] ?? student.student_id ?? student.studentId ?? student.id),
          fullName: getStudentName(student),
          avatarUrl: clean(student.avatar_url) || '',
          className: clean(student['الفئة'] ?? student.class ?? student.class_name) || 'غير محدد',
          phone: clean(student['رقم الهاتف'] ?? student.phone),
          year: getStudentYear(student) || 'غير محدد',
        };
      }).filter((student) => student.id && assignments.some((assignment) => assignment.year === student.year));
      const studentYears = new Map(students.map((student) => [student.id, student.year]));
      const studentClasses = new Map(students.map((student) => [student.id, student.className]));
      const attendance = (attendanceResult.data ?? []).flatMap((row) => {
        const record = row as Record<string, unknown>;
        const subjectName = clean(record['المادة'] ?? record.course ?? record.subject);
        const studentId = clean(record['الرقم الجامعي'] ?? record.student_id ?? record.studentId);
        const year = normalizeYear(studentYears.get(studentId));
        const assignment = assignments.find((item) => item.name === subjectName && item.year === year);
        if (!assignment) return [];
        return [{
          id: clean(record.id ?? record.attendance_id ?? record['معرف الحضور'] ?? `${studentId}-${record['التاريخ'] ?? record.date}-${subjectName}`),
          studentId,
          subject: assignment.label,
          status: clean(record['الحالة'] ?? record.status) || 'غير محدد',
          date: clean(record['التاريخ'] ?? record.date ?? record.created_at),
          details: clean(record['تفاصيل الغياب'] ?? record['التفاصيل'] ?? record.note),
          className: clean(record['الفئة'] ?? record.class ?? record.class_name) || 'غير محدد',
        }];
      });
      const attendanceKeys = new Set(attendance
        .filter((record) => ['غائب', 'غياب', 'متغيب', 'absent'].includes(normalized(record.status)))
        .map((record) => attendanceKey(record.studentId, record.subject, record.date)));
      const absenceWarnings = (warningsResult.data ?? []).flatMap((row) => {
        const warning = row as Record<string, unknown>;
        const studentId = clean(warning['الرقم الجامعي'] ?? warning.student_id ?? warning.studentId);
        const warningType = clean(warning['نوع الإنذار'] ?? warning.type);
        const reason = clean(warning['السبب'] ?? warning.reason);
        if (!studentId || (!warningType.includes('غياب') && !/^غياب(?:\s|$)/.test(reason))) return [];

        const reasonCourse = reason.match(/غياب\s+في\s+مادة\s+(.+)$/)?.[1]?.trim() ?? '';
        const subjectName = clean(warning['المادة'] ?? warning.course ?? warning.subject) || reasonCourse;
        const year = normalizeYear(studentYears.get(studentId));
        const assignment = assignments.find((item) => normalized(item.name) === normalized(subjectName) && item.year === year);
        if (!assignment) return [];

        const date = clean(warning['التاريخ'] ?? warning.date ?? warning.created_at);
        const subject = assignment.label;
        if (date && attendanceKeys.has(attendanceKey(studentId, subject, date))) return [];
        return [{
          id: `warning-${clean(warning.warnig_id ?? warning.warning_id ?? warning.id) || `${studentId}-${date}-${subject}`}`,
          studentId,
          subject,
          status: 'غائب',
          date,
          details: clean(warning['التفاصيل'] ?? warning.details ?? reason),
          className: clean(warning['الفئة'] ?? warning.class ?? warning.class_name) || studentClasses.get(studentId) || 'غير محدد',
        }];
      });
      attendance.push(...absenceWarnings);
      const alerts = (alertsResult.data ?? []).flatMap((alert) => {
        const year = normalizeYear(alert.student_year);
        const assignment = assignments.find((item) => item.name === clean(alert.subject) && item.year === year);
        return assignment ? [{ ...alert, subject: assignment.label }] : [];
      });
      return NextResponse.json({
        success: true,
        teacher: {
          id: teacher.id,
          name: teacher.teacher_name,
          subjects: assignmentLabels,
          telegramChatId: clean(teacher.telegram_chat_id),
        },
        students,
        attendance,
        alerts,
      });
    }

    if (body.action === 'add-alert') {
      const studentId = clean(body.studentId);
      const assignmentLabel = clean(body.subject);
      const message = clean(body.message);
      const assignment = assignments.find((item) => item.label === assignmentLabel);
      if (!studentId || !assignment || message.length < 3 || message.length > 1000) {
        return errorResponse('invalid-teacher-alert', 400);
      }
      const { data: student, error: studentError } = await supabase
        .from('students')
        .select('*')
        .eq('الرقم الجامعي', studentId)
        .maybeSingle();
      if (studentError) return errorResponse('student-lookup-failed', 500);
      if (!student) return errorResponse('student-not-found', 404);
      const studentYear = getStudentYear(student as Record<string, unknown>);
      if (studentYear !== assignment.year) return errorResponse('student-year-mismatch', 403);
      const { data, error } = await supabase.from('teacher_alerts').insert({
        teacher_id: teacher.id,
        teacher_name: teacher.teacher_name,
        student_id: studentId,
        student_name: getStudentName(student as Record<string, unknown>),
        subject: assignment.name,
        student_year: assignment.year,
        message,
      }).select('id, student_id, subject, student_year, message, created_at').single();
      if (error) return errorResponse('teacher-alert-save-failed', 500);
      return NextResponse.json({ success: true, alert: { ...data, subject: assignment.label } });
    }

    if (body.action === 'delete-alert') {
      const alertId = Number(body.alertId);
      if (!Number.isSafeInteger(alertId) || alertId <= 0) return errorResponse('invalid-alert-id', 400);
      const { data, error } = await supabase.from('teacher_alerts')
        .delete()
        .eq('id', alertId)
        .eq('teacher_id', teacher.id)
        .select('id')
        .maybeSingle();
      if (error) return errorResponse('teacher-alert-delete-failed', 500);
      if (!data) return errorResponse('teacher-alert-not-found', 404);
      return NextResponse.json({ success: true });
    }

    return errorResponse('invalid-action', 400);
  } catch (error) {
    console.error('TEACHER_PORTAL_REQUEST_FAILED:', error);
    return errorResponse('teacher-portal-request-failed', 500);
  }
}
