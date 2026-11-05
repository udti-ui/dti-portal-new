'use client';

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDownToLine,
  BookOpen,
  CalendarDays,
  Clock3,
  Download,
  FileText,
  GraduationCap,
  RefreshCw,
  Trash2,
  Upload,
} from 'lucide-react';

type Assignment = {
  name: string;
  year: 'أولى' | 'ثانية';
};

type Lecture = {
  id: number | string;
  title: string;
  subject: string;
  student_year: 'أولى' | 'ثانية';
  teacher_name: string;
  file_name: string;
  file_size: number;
  created_at: string;
};

type SharedCredentials = {
  username: string;
  password: string;
};

type CourseMaterialsPanelProps =
  | { mode: 'student'; studentId: string; password: string }
  | ({ mode: 'teacher' } & SharedCredentials)
  | ({ mode: 'supervisor'; supervisorUsername: string; supervisorPassword: string; onBack: () => void });

type ApiResult = {
  success?: boolean;
  error?: string;
  subjects?: Assignment[];
  lectures?: Lecture[];
  url?: string;
  downloadName?: string;
  notification?: { status?: string; sent?: number; failed?: number };
  upload?: { signedUrl: string; path: string; fileName: string; fileSize: number };
};

const years: Assignment['year'][] = ['أولى', 'ثانية'];
const assignmentKey = (assignment: Assignment) => `${assignment.year}::${assignment.name}`;
const sizeLabel = (size: number) => `${(size / (1024 * 1024)).toFixed(1)} ميغابايت`;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();
const safeDownloadName = (name: string) => {
  const safeName = name.replace(/\.pdf$/i, '')
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .trim()
    .slice(0, 180)
    .trim();
  return `${safeName || 'محاضرة'}.pdf`;
};

const errorMessages: Record<string, string> = {
  'course-lectures-server-key-missing': 'خدمة المقررات غير مهيأة على الخادم.',
  'course-lectures-schema-not-configured': 'شغّل ملف supabase-announcements.sql في Supabase أولًا.',
  'student-credentials-required': 'بيانات الطالب غير مكتملة.',
  'student-credentials-invalid': 'تعذر التحقق من بيانات الطالب.',
  'teacher-credentials-required': 'بيانات المدرس غير مكتملة.',
  'teacher-credentials-invalid': 'انتهت صلاحية جلسة المدرس. سجّل الدخول من جديد.',
  'supervisor-credentials-required': 'بيانات المشرف غير مكتملة.',
  'supervisor-credentials-invalid': 'بيانات المشرف غير صحيحة أو لا يملك صلاحية إدارة المقررات.',
  'course-subject-not-found': 'المادة المحددة غير موجودة.',
  'course-lecture-not-found': 'المحاضرة غير موجودة أو لم تعد متاحة.',
  'course-lecture-invalid': 'تحقق من عنوان المحاضرة والمادة والسنة والملف.',
  'lecture-pdf-invalid': 'يجب اختيار ملف PDF صالح لا يتجاوز حجمه 20 ميغابايت.',
  'lecture-storage-configuration-failed': 'تعذر تجهيز مخزن المحاضرات. تحقق من مفتاح الخدمة وصلاحيات Storage في Supabase.',
  'lecture-storage-bucket-missing': 'مخزن ملفات المحاضرات غير موجود. أعد تشغيل supabase-announcements.sql.',
  'lecture-upload-authorize-failed': 'تعذر بدء الرفع. تحقق من إعدادات مخزن المحاضرات في Supabase.',
  'lecture-upload-not-found': 'لم يكتمل رفع الملف إلى التخزين. أعد المحاولة وتأكد من اتصال الإنترنت.',
  'lecture-upload-verification-failed': 'لم يتطابق الملف المرفوع مع بيانات PDF المطلوبة. اختر الملف وأعد المحاولة.',
  'lecture-upload-failed': 'تعذر رفع ملف المحاضرة إلى التخزين.',
  'save-failed': 'تعذر حفظ المحاضرة.',
  'delete-failed': 'تعذر حذف المحاضرة.',
  'list-failed': 'تعذر تحميل المحاضرات.',
  'catalog-load-failed': 'تعذر تحميل قائمة المواد.',
  'download-lookup-failed': 'تعذر تجهيز رابط تنزيل المحاضرة.',
  'course-lecture-download-failed': 'تعذر تنزيل ملف المحاضرة.',
};

const getErrorMessage = (error?: string) =>
  errorMessages[error ?? ''] ?? 'حدث خطأ أثناء تنفيذ الطلب. حاول مرة أخرى.';

const uploadFileWithProgress = (
  signedUrl: string,
  file: File,
  onProgress: (progress: number) => void
) => new Promise<void>((resolve, reject) => {
  if (!supabaseAnonKey) {
    reject(new Error('إعداد مفتاح Supabase العام غير مكتمل على الموقع. حدّث NEXT_PUBLIC_SUPABASE_ANON_KEY ثم أعد تشغيل التطبيق.'));
    return;
  }
  const xhr = new XMLHttpRequest();
  xhr.open('PUT', signedUrl);
  xhr.timeout = 10 * 60 * 1000;
  xhr.setRequestHeader('apikey', supabaseAnonKey);
  xhr.setRequestHeader('Authorization', `Bearer ${supabaseAnonKey}`);
  xhr.setRequestHeader('x-upsert', 'false');
  xhr.upload.onprogress = (event) => {
    if (event.lengthComputable) onProgress(Math.min(100, Math.round((event.loaded / event.total) * 100)));
  };
  xhr.onload = () => {
    if (xhr.status >= 200 && xhr.status < 300) {
      onProgress(100);
      resolve();
      return;
    }
    let message = '';
    try {
      const body = JSON.parse(xhr.responseText) as { message?: string; error?: string; statusCode?: string };
      message = body.message ?? body.error ?? body.statusCode ?? '';
    } catch {
      message = xhr.responseText.slice(0, 300);
    }
    console.error('COURSE_LECTURE_BROWSER_UPLOAD_FAILED:', {
      status: xhr.status,
      message,
    });
    if (xhr.status === 413 || /too large|entity too large|payload/i.test(message)) {
      reject(new Error('حجم الملف يتجاوز الحد المسموح به في إعدادات التخزين. جرّب ملفًا أصغر أو ارفع الحد العام في إعدادات Supabase.'));
      return;
    }
    if (xhr.status === 404 || /bucket.*not found/i.test(message)) {
      reject(new Error('مخزن ملفات المحاضرات غير موجود. أعد تشغيل supabase-announcements.sql وتأكد من إعدادات Supabase.'));
      return;
    }
    if (xhr.status === 401 || xhr.status === 403) {
      reject(new Error('رفض Supabase عملية الرفع. تحقق من صلاحيات Storage ومفتاح الخدمة وإعدادات المخزن.'));
      return;
    }
    if (xhr.status === 400) {
      reject(new Error('رابط الرفع غير صالح أو انتهت صلاحيته. اضغط رفع من جديد لإصدار رابط آمن جديد.'));
      return;
    }
    if (xhr.status >= 500) {
      reject(new Error('خدمة تخزين Supabase غير متاحة مؤقتًا. انتظر قليلًا ثم أعد المحاولة.'));
      return;
    }
    reject(new Error('فشل رفع الملف إلى Supabase. تحقق من اتصال الإنترنت وإعدادات Storage في المشروع ثم أعد المحاولة.'));
  };
  xhr.onerror = () => reject(new Error('تعذر الاتصال بمخزن Supabase. تحقق من اتصال الإنترنت وإعداد CORS لمشروع التخزين.'));
  xhr.ontimeout = () => reject(new Error('استغرق الرفع وقتًا طويلًا وانتهت المهلة. تحقق من الاتصال وحاول مجددًا.'));
  xhr.onabort = () => reject(new Error('تم إلغاء رفع المحاضرة.'));
  const formData = new FormData();
  formData.append('cacheControl', '3600');
  formData.append('', file);
  xhr.send(formData);
});

const downloadFileWithProgress = (
  url: string,
  fileName: string,
  onProgress: (progress: number) => void
) => new Promise<void>((resolve, reject) => {
  const xhr = new XMLHttpRequest();
  xhr.open('GET', url);
  xhr.responseType = 'blob';
  xhr.timeout = 10 * 60 * 1000;
  xhr.onprogress = (event) => {
    if (event.lengthComputable && event.total > 0) {
      onProgress(Math.min(100, Math.round((event.loaded / event.total) * 100)));
    }
  };
  xhr.onload = () => {
    if (xhr.status < 200 || xhr.status >= 300 || !xhr.response?.size) {
      console.error('COURSE_LECTURE_BROWSER_DOWNLOAD_FAILED:', { status: xhr.status });
      reject(new Error('تعذر تنزيل ملف المحاضرة. تحقق من اتصال الإنترنت وحاول مجددًا.'));
      return;
    }
    const objectUrl = URL.createObjectURL(xhr.response as Blob);
    const link = document.createElement('a');
    link.href = objectUrl;
    link.download = fileName;
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
    onProgress(100);
    resolve();
  };
  xhr.onerror = () => reject(new Error('تعذر الاتصال بمخزن المحاضرات. تحقق من اتصال الإنترنت.'));
  xhr.ontimeout = () => reject(new Error('انتهت مهلة التنزيل. حاول مجددًا.'));
  xhr.onabort = () => reject(new Error('تم إلغاء تنزيل المحاضرة.'));
  xhr.send();
});

export default function CourseMaterialsPanel(props: CourseMaterialsPanelProps) {
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [lectures, setLectures] = useState<Lecture[]>([]);
  const [selectedAssignmentKey, setSelectedAssignmentKey] = useState('');
  const [studentSelectedYear, setStudentSelectedYear] = useState<Assignment['year']>('أولى');
  const [title, setTitle] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadStage, setUploadStage] = useState<'authorizing' | 'uploading' | 'saving' | null>(null);
  const [busyLectureId, setBusyLectureId] = useState<string | null>(null);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const requestId = useRef(0);
  const catalogInitialized = useRef(false);
  const studentSelectedYearRef = useRef<Assignment['year']>('أولى');

  const isStudent = props.mode === 'student';
  const isSupervisor = props.mode === 'supervisor';
  const studentId = props.mode === 'student' ? props.studentId : '';
  const studentPassword = props.mode === 'student' ? props.password : '';
  const teacherUsername = props.mode === 'teacher' ? props.username : '';
  const teacherPassword = props.mode === 'teacher' ? props.password : '';
  const supervisorUsername = props.mode === 'supervisor' ? props.supervisorUsername : '';
  const supervisorPassword = props.mode === 'supervisor' ? props.supervisorPassword : '';
  const selectedAssignment = useMemo(
    () => assignments.find((assignment) => assignmentKey(assignment) === selectedAssignmentKey) ?? null,
    [assignments, selectedAssignmentKey]
  );
  const visibleLectures = useMemo(
    () => selectedAssignment
      ? lectures.filter((lecture) => lecture.subject === selectedAssignment.name && lecture.student_year === selectedAssignment.year)
      : lectures,
    [lectures, selectedAssignment]
  );

  const credentials = useCallback(() => {
    if (props.mode === 'student') return { studentId, password: studentPassword };
    if (props.mode === 'teacher') return { username: teacherUsername, password: teacherPassword };
    return { supervisorUsername, supervisorPassword };
  }, [props.mode, studentId, studentPassword, supervisorPassword, supervisorUsername, teacherPassword, teacherUsername]);

  const sendRequest = useCallback(async (action: string, extra: Record<string, string> = {}) => {
    const response = await fetch('/api/course-lectures', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, ...credentials(), ...extra }),
    });
    const result = await response.json() as ApiResult;
    if (!response.ok || !result.success) throw new Error(getErrorMessage(result.error));
    return result;
  }, [credentials]);

  const loadInitialData = useCallback(async () => {
    const currentRequestId = ++requestId.current;
    setLoading(true);
    setNotice(null);
    try {
      const action = props.mode === 'student'
        ? 'student-catalog'
        : props.mode === 'teacher' ? 'teacher-list' : 'supervisor-list';
      const result = await sendRequest(action);
      if (requestId.current !== currentRequestId) return;
      const nextAssignments = result.subjects ?? [];
      setAssignments(nextAssignments);
      if (props.mode !== 'student') setLectures(result.lectures ?? []);
      if (props.mode === 'student' && !catalogInitialized.current) {
        const initialYear = nextAssignments[0]?.year ?? 'أولى';
        studentSelectedYearRef.current = initialYear;
        setStudentSelectedYear(initialYear);
        catalogInitialized.current = true;
      }
      setSelectedAssignmentKey((current) => {
        const preferredYear = props.mode === 'student'
          ? studentSelectedYearRef.current
          : nextAssignments[0]?.year;
        const currentAssignment = nextAssignments.find((assignment) => assignmentKey(assignment) === current);
        if (currentAssignment && (props.mode !== 'student' || currentAssignment.year === preferredYear)) {
          return current;
        }
        const preferredAssignment = nextAssignments.find((assignment) => assignment.year === preferredYear);
        return preferredAssignment ? assignmentKey(preferredAssignment) : '';
      });
    } catch (error) {
      if (requestId.current === currentRequestId) {
        setNotice({ text: error instanceof Error ? error.message : getErrorMessage(), error: true });
      }
    } finally {
      if (requestId.current === currentRequestId) setLoading(false);
    }
  }, [props.mode, sendRequest]);

  useEffect(() => {
    void loadInitialData();
    return () => { requestId.current += 1; };
  }, [loadInitialData]);

  const loadStudentLectures = useCallback(async () => {
    if (!isStudent || !selectedAssignment) return;
    const currentRequestId = ++requestId.current;
    setLoading(true);
    try {
      const result = await sendRequest('student-list', {
        subject: selectedAssignment.name,
        studentYear: selectedAssignment.year,
      });
      if (requestId.current === currentRequestId) setLectures(result.lectures ?? []);
    } catch (error) {
      if (requestId.current === currentRequestId) {
        setNotice({ text: error instanceof Error ? error.message : getErrorMessage(), error: true });
      }
    } finally {
      if (requestId.current === currentRequestId) setLoading(false);
    }
  }, [isStudent, selectedAssignment, sendRequest]);

  useEffect(() => {
    void loadStudentLectures();
  }, [loadStudentLectures]);

  const selectedYear = selectedAssignment?.year ?? years[0];
  const availableAssignmentsForYear = assignments.filter((assignment) => assignment.year === selectedYear);
  const studentAssignmentsForYear = assignments.filter((assignment) => assignment.year === studentSelectedYear);

  const submitLecture = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedAssignment || !file) {
      setNotice({ text: 'اختر المادة وارفق ملف المحاضرة بصيغة PDF.', error: true });
      return;
    }
    if (!file.name.toLowerCase().endsWith('.pdf') || file.size > 20 * 1024 * 1024) {
      setNotice({ text: getErrorMessage('lecture-pdf-invalid'), error: true });
      return;
    }
    setSaving(true);
    setUploadProgress(0);
    setUploadStage('authorizing');
    setNotice(null);
    try {
      const signature = await file.slice(0, 5).text();
      if (signature !== '%PDF-') throw new Error(getErrorMessage('lecture-pdf-invalid'));
      const uploadAction = isSupervisor ? 'supervisor-prepare-upload' : 'teacher-prepare-upload';
      const prepared = await sendRequest(uploadAction, {
        subject: selectedAssignment.name,
        studentYear: selectedAssignment.year,
        title: title.trim(),
        fileName: file.name,
        fileSize: String(file.size),
        fileType: file.type || 'application/pdf',
      });
      if (!prepared.upload) throw new Error(getErrorMessage('lecture-upload-authorize-failed'));

      setUploadStage('uploading');
      await uploadFileWithProgress(prepared.upload.signedUrl, file, setUploadProgress);

      setUploadStage('saving');
      const completeAction = isSupervisor ? 'supervisor-complete-upload' : 'teacher-complete-upload';
      const result = await sendRequest(completeAction, {
        subject: selectedAssignment.name,
        studentYear: selectedAssignment.year,
        title: title.trim(),
        path: prepared.upload.path,
        fileName: prepared.upload.fileName,
        fileSize: String(prepared.upload.fileSize),
      });
      setTitle('');
      setFile(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
      setNotice(result.notification?.status === 'missing_bot_token'
        ? { text: 'تم رفع المحاضرة، لكن إشعار تيليجرام غير مهيأ على الخادم.', error: false }
        : result.notification?.status === 'no_subscribers'
          ? { text: 'تم رفع المحاضرة. لا يوجد طلاب فعّلوا إشعارات تيليجرام لهذه السنة.', error: false }
          : (result.notification?.failed ?? 0) > 0
            ? { text: `تم رفع المحاضرة وإرسال ${result.notification?.sent ?? 0} إشعارًا، وتعذر إرسال ${result.notification?.failed} إشعار.`, error: false }
            : { text: `تم رفع المحاضرة وإرسال الإشعار إلى ${result.notification?.sent ?? 0} طالب.`, error: false });
      await loadInitialData();
    } catch (error) {
      setNotice({ text: error instanceof Error ? error.message : getErrorMessage(), error: true });
    } finally {
      setSaving(false);
      setUploadStage(null);
      setUploadProgress(0);
    }
  };

  const downloadLecture = async (lecture: Lecture) => {
    setBusyLectureId(String(lecture.id));
    setDownloadProgress(0);
    setNotice(null);
    try {
      const action = props.mode === 'student'
        ? 'student-download'
        : props.mode === 'teacher' ? 'teacher-download' : 'supervisor-download';
      const result = await sendRequest(action, { lectureId: String(lecture.id) });
      if (!result.url) throw new Error(getErrorMessage('course-lecture-download-failed'));
      const downloadName = safeDownloadName(result.downloadName ?? `${lecture.subject} - ${lecture.title}`);
      await downloadFileWithProgress(result.url, downloadName, setDownloadProgress);
    } catch (error) {
      setNotice({ text: error instanceof Error ? error.message : getErrorMessage(), error: true });
    } finally {
      setBusyLectureId(null);
      setDownloadProgress(0);
    }
  };

  const deleteLecture = async (lecture: Lecture) => {
    if (!window.confirm(`هل تريد حذف محاضرة «${lecture.title}»؟`)) return;
    setBusyLectureId(String(lecture.id));
    setNotice(null);
    try {
      await sendRequest(isSupervisor ? 'supervisor-delete' : 'teacher-delete', {
        lectureId: String(lecture.id),
      });
      setLectures((current) => current.filter((item) => item.id !== lecture.id));
      setNotice({ text: 'تم حذف المحاضرة.', error: false });
    } catch (error) {
      setNotice({ text: error instanceof Error ? error.message : getErrorMessage(), error: true });
    } finally {
      setBusyLectureId(null);
    }
  };

  if (isStudent) {
    return (
      <section className="course-student-panel" dir="rtl" aria-labelledby="student-courses-heading">
        <header className="course-student-hero">
          <div className="course-student-hero-icon" aria-hidden="true"><BookOpen size={28} /></div>
          <div className="course-student-hero-copy">
            <span className="course-student-eyebrow">مكتبتك الدراسية</span>
            <h2 id="student-courses-heading">المقررات والمحاضرات</h2>
            <p>اختَر سنتك، ثم المادة التي تريدها، وستجد محاضراتها جاهزة للتنزيل.</p>
          </div>
          <button
            type="button"
            className="course-student-refresh"
            onClick={() => void loadInitialData()}
            disabled={loading}
            aria-label="تحديث المقررات والمحاضرات"
          >
            <RefreshCw size={17} className={loading ? 'course-spinning' : ''} />
            <span>تحديث</span>
          </button>
          <div className="course-student-hero-art" aria-hidden="true">
            <GraduationCap size={104} strokeWidth={1.2} />
          </div>
        </header>

        {notice && (
          <div className={`course-student-notice${notice.error ? ' is-error' : ''}`} role={notice.error ? 'alert' : 'status'}>
            {notice.text}
          </div>
        )}

        <div className="course-student-section">
          <div className="course-student-section-heading">
            <span className="course-student-step">١</span>
            <div>
              <h3>اختر السنة الدراسية</h3>
              <p>تظهر لك مواد السنتين لتتمكن من تصفح المحاضرات.</p>
            </div>
          </div>
          <div className="course-student-year-grid">
            {years.map((year, index) => {
              const count = assignments.filter((assignment) => assignment.year === year).length;
              const selected = studentSelectedYear === year;
              return (
                <button
                  type="button"
                  key={year}
                  className={`course-student-year-card${selected ? ' is-selected' : ''}`}
                  onClick={() => {
                    studentSelectedYearRef.current = year;
                    setStudentSelectedYear(year);
                    const first = assignments.find((assignment) => assignment.year === year);
                    setSelectedAssignmentKey(first ? assignmentKey(first) : '');
                    setLectures([]);
                  }}
                  aria-pressed={selected}
                >
                  <span className="course-student-year-icon"><GraduationCap size={22} /></span>
                  <span className="course-student-year-copy">
                    <strong>السنة {year}</strong>
                    <small>{loading && assignments.length === 0 ? 'جارٍ التحميل...' : `${count} ${count === 1 ? 'مادة' : 'مواد'}`}</small>
                  </span>
                  <span className="course-student-year-number">0{index + 1}</span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="course-student-section">
          <div className="course-student-section-heading">
            <span className="course-student-step">٢</span>
            <div>
              <h3>اختر المادة</h3>
              <p>اضغط على بطاقة المادة لعرض المحاضرات المتاحة.</p>
            </div>
          </div>
          {loading && assignments.length === 0 ? (
            <div className="course-student-empty"><span className="course-student-loader" /> جارٍ تجهيز قائمة المواد...</div>
          ) : studentAssignmentsForYear.length === 0 ? (
            <div className="course-student-empty">
              <BookOpen size={25} />
              <strong>لا توجد مواد مضافة لهذه السنة بعد</strong>
              <span>جرّب السنة الأخرى أو عُد لاحقًا.</span>
            </div>
          ) : (
            <div className="course-student-subject-grid">
              {studentAssignmentsForYear.map((assignment, index) => {
                const selected = assignmentKey(assignment) === selectedAssignmentKey;
                return (
                  <button
                    type="button"
                    key={assignmentKey(assignment)}
                    className={`course-student-subject-card${selected ? ' is-selected' : ''}`}
                    onClick={() => {
                      setSelectedAssignmentKey(assignmentKey(assignment));
                      setLectures([]);
                    }}
                    aria-pressed={selected}
                  >
                    <span className="course-student-subject-icon"><BookOpen size={20} /></span>
                    <span className="course-student-subject-name">{assignment.name}</span>
                    <span className="course-student-subject-index">مادة {String(index + 1).padStart(2, '0')}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {selectedAssignment && (
          <div className="course-student-lectures">
            <div className="course-student-lectures-heading">
              <div className="course-student-section-heading">
                <span className="course-student-step">٣</span>
                <div>
                  <h3>محاضرات {selectedAssignment.name}</h3>
                  <p><CalendarDays size={14} /> السنة {selectedAssignment.year}</p>
                </div>
              </div>
              <span className="course-student-count">
                {loading ? '...' : `${visibleLectures.length} ${visibleLectures.length === 1 ? 'محاضرة' : 'محاضرات'}`}
              </span>
            </div>

            {loading ? (
              <div className="course-student-empty"><span className="course-student-loader" /> جارٍ تحميل محاضرات المادة...</div>
            ) : visibleLectures.length === 0 ? (
              <div className="course-student-empty">
                <FileText size={26} />
                <strong>لا توجد محاضرات لهذه المادة حاليًا</strong>
                <span>ستظهر هنا فور إضافة محاضرة جديدة.</span>
              </div>
            ) : (
              <div className="course-student-lecture-list">
                {visibleLectures.map((lecture, index) => (
                  <article className="course-student-lecture-card" key={lecture.id}>
                    <span className="course-student-pdf-icon" aria-hidden="true"><FileText size={22} /></span>
                    <span className="course-student-lecture-number">{String(index + 1).padStart(2, '0')}</span>
                    <div className="course-student-lecture-copy">
                      <strong>{lecture.title}</strong>
                      <span>{lecture.file_name} <i /> {sizeLabel(lecture.file_size)}</span>
                      <small><Clock3 size={13} /> أضيفت {new Date(lecture.created_at).toLocaleDateString('ar-SY')}</small>
                    </div>
                    <button
                      type="button"
                      className="course-student-download"
                      onClick={() => void downloadLecture(lecture)}
                      disabled={busyLectureId === String(lecture.id)}
                    >
                      {busyLectureId === String(lecture.id) ? <span className="course-student-loader" /> : <ArrowDownToLine size={17} />}
                      <span>{busyLectureId === String(lecture.id) ? `جارٍ التنزيل ${downloadProgress}%` : 'تنزيل المحاضرة'}</span>
                    </button>
                    {busyLectureId === String(lecture.id) && (
                      <progress className="course-download-progress-bar" max={100} value={downloadProgress} aria-label="تقدم تنزيل المحاضرة" />
                    )}
                  </article>
                ))}
              </div>
            )}
          </div>
        )}
      </section>
    );
  }

  return (
    <section style={{ display: 'grid', gap: 18, padding: 18, borderRadius: 16, background: '#fff', boxShadow: '0 8px 28px rgba(15, 23, 42, .08)' }}>
      <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h2 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}><BookOpen size={22} /> المقررات والمحاضرات</h2>
          <p style={{ margin: '6px 0 0', color: '#64748b' }}>
            {isStudent ? 'اختر أي مادة من السنة الأولى أو الثانية لتنزيل محاضراتها.' : 'إدارة ملفات محاضرات المواد الدراسية بصيغة PDF.'}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {props.mode === 'supervisor' && <button type="button" className="action-button" onClick={props.onBack}>العودة للوظائف</button>}
          <button type="button" className="action-button" onClick={() => void (async () => {
            await loadInitialData();
            if (isStudent) await loadStudentLectures();
          })()} disabled={loading}>
            <RefreshCw size={16} /> تحديث
          </button>
        </div>
      </header>

      {notice && (
        <div role="status" style={{ padding: 12, borderRadius: 10, color: notice.error ? '#991b1b' : '#166534', background: notice.error ? '#fee2e2' : '#dcfce7' }}>
          {notice.text}
        </div>
      )}

      {loading && !assignments.length ? <p>جارٍ تحميل المواد...</p> : assignments.length === 0 ? (
        <p style={{ margin: 0, color: '#64748b' }}>لا توجد مواد دراسية مضافة حاليًا.</p>
      ) : (
        <>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <label style={{ display: 'grid', gap: 6 }}>
              السنة الدراسية
              <select
                value={selectedYear}
                onChange={(event) => {
                  const nextYear = event.target.value as Assignment['year'];
                  const first = assignments.find((assignment) => assignment.year === nextYear);
                  setSelectedAssignmentKey(first ? assignmentKey(first) : '');
                }}
              >
                {years.map((year) => <option key={year} value={year}>السنة {year}</option>)}
              </select>
            </label>
            <label style={{ display: 'grid', gap: 6 }}>
              المادة
              <select
                value={selectedAssignmentKey}
                onChange={(event) => setSelectedAssignmentKey(event.target.value)}
              >
                {availableAssignmentsForYear.map((assignment) => (
                  <option key={assignmentKey(assignment)} value={assignmentKey(assignment)}>{assignment.name}</option>
                ))}
              </select>
            </label>
          </div>

          {!isStudent && selectedAssignment && (
            <form onSubmit={(event) => void submitLecture(event)} style={{ display: 'grid', gap: 12, padding: 16, borderRadius: 12, background: '#f8fafc' }}>
              <h3 style={{ margin: 0 }}>رفع محاضرة جديدة</h3>
              <label style={{ display: 'grid', gap: 6 }}>
                عنوان المحاضرة
                <input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={180} required />
              </label>
              <label style={{ display: 'grid', gap: 6 }}>
                ملف المحاضرة (PDF، حتى 20 ميغابايت)
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="application/pdf,.pdf"
                  onChange={(event) => setFile(event.target.files?.[0] ?? null)}
                  required
                />
              </label>
              {file && (
                <div className="course-upload-file-summary">
                  <FileText size={18} />
                  <span>{file.name}</span>
                  <small>{sizeLabel(file.size)}</small>
                </div>
              )}
              {uploadStage && (
                <div className="course-upload-progress" role="status" aria-live="polite">
                  <div className="course-upload-progress-heading">
                    <span>
                      {uploadStage === 'authorizing' && 'جارٍ تجهيز اتصال آمن...'}
                      {uploadStage === 'uploading' && `جارٍ رفع الملف إلى التخزين... ${uploadProgress}%`}
                      {uploadStage === 'saving' && 'اكتمل رفع الملف، جارٍ حفظ بيانات المحاضرة...'}
                    </span>
                    {uploadStage === 'uploading' && <strong>{uploadProgress}%</strong>}
                  </div>
                  <progress
                    className="course-upload-progress-bar"
                    max={100}
                    value={uploadStage === 'uploading' ? uploadProgress : uploadStage === 'saving' ? 100 : 0}
                    aria-label="تقدم رفع المحاضرة"
                  />
                </div>
              )}
              <button type="submit" className="action-button primary" disabled={saving || loading}>
                <Upload size={16} /> {saving
                  ? uploadStage === 'authorizing' ? 'جارٍ تجهيز الرفع...' : uploadStage === 'saving' ? 'جارٍ حفظ المحاضرة...' : `جارٍ الرفع ${uploadProgress}%`
                  : `رفع إلى ${selectedAssignment.name} · السنة ${selectedAssignment.year}`}
              </button>
            </form>
          )}

          <div style={{ display: 'grid', gap: 10 }}>
            <h3 style={{ margin: 0 }}>محاضرات {selectedAssignment?.name} · السنة {selectedAssignment?.year}</h3>
            {loading ? <p>جارٍ تحميل المحاضرات...</p> : visibleLectures.length === 0 ? (
              <p style={{ margin: 0, color: '#64748b' }}>لا توجد محاضرات مضافة لهذه المادة حتى الآن.</p>
            ) : visibleLectures.map((lecture) => (
              <article key={lecture.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', padding: 14, border: '1px solid #e2e8f0', borderRadius: 12 }}>
                <div>
                  <strong>{lecture.title}</strong>
                  <div style={{ marginTop: 5, color: '#64748b', fontSize: 13 }}>
                    {lecture.teacher_name} · {lecture.file_name} · {sizeLabel(lecture.file_size)}
                  </div>
                  <time dateTime={lecture.created_at} style={{ color: '#94a3b8', fontSize: 12 }}>
                    {new Date(lecture.created_at).toLocaleString('ar-SY')}
                  </time>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    type="button"
                    className="action-button primary"
                    onClick={() => void downloadLecture(lecture)}
                    disabled={busyLectureId === String(lecture.id)}
                  >
                    <Download size={16} />
                    {busyLectureId === String(lecture.id) ? `تنزيل ${downloadProgress}%` : 'تنزيل PDF'}
                  </button>
                  {!isStudent && (
                    <button type="button" className="action-button" onClick={() => void deleteLecture(lecture)} disabled={busyLectureId === String(lecture.id)}>
                      <Trash2 size={16} /> حذف
                    </button>
                  )}
                </div>
                {busyLectureId === String(lecture.id) && (
                  <progress className="course-download-progress-bar" max={100} value={downloadProgress} aria-label="تقدم تنزيل المحاضرة" />
                )}
              </article>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
