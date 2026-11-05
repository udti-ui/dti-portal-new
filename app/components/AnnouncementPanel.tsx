'use client';

import { FormEvent, useEffect, useMemo, useState } from 'react';
import Image from 'next/image';
import { Trash2 } from 'lucide-react';

type Announcement = {
  id: number;
  title: string;
  content: string;
  subject: string | null;
  student_year: string | null;
  target_scope?: 'year' | 'all';
  author_type: 'admin' | 'teacher';
  author_name: string;
  created_at: string;
  is_read?: boolean;
  attachment_url?: string;
  attachment_name?: string | null;
  attachment_type?: string | null;
  attachment_size?: number | null;
};

type NotificationResult = {
  status?: string;
  sent?: number;
  failed?: number;
};

const noSubjects: string[] = [];

type AnnouncementPanelProps =
  | {
    mode: 'student';
    studentId: string;
    password: string;
    studentYear: string;
  }
  | {
    mode: 'supervisor';
    supervisorUsername: string;
    supervisorPassword: string;
    onBack: () => void;
  }
  | {
    mode: 'teacher';
    username: string;
    password: string;
    subjects: string[];
  };

const formatDate = (value: string) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('ar-SY');
};

const getErrorMessage = (error: string | undefined) => {
  const messages: Record<string, string> = {
    'student-credentials-invalid': 'تعذر التحقق من بيانات الطالب.',
    'student-credentials-required': 'بيانات الطالب غير مكتملة.',
    'invalid-student-year': 'السنة الدراسية المسجلة للحساب غير صالحة.',
    'announcements-load-failed': 'تعذر تحميل الإعلانات.',
    'announcement-server-key-missing': 'خدمة الإعلانات غير مهيأة على الخادم.',
    'supervisor-lookup-failed': 'تعذر التحقق من حساب المشرف. حاول مرة أخرى.',
    'announcement-read-failed': 'تعذر تحديث حالة قراءة الإعلان.',
    'announcement-not-found': 'الإعلان غير موجود.',
    'announcement-schema-not-configured': 'يجب تشغيل ملف supabase-announcements.sql في Supabase أولًا.',
    'announcement-attachment-invalid': 'نوع الملف غير مدعوم أو تجاوز حجمه 5 ميغابايت.',
    'announcement-attachment-save-failed': 'تعذر حفظ المرفق. تحقق من إعداد مخزن الإعلانات في Supabase.',
    'announcement-attachment-load-failed': 'تعذر تجهيز رابط المرفق. حاول مرة أخرى.',
    'supervisor-credentials-invalid': 'بيانات المشرف غير صحيحة أو لا يملك صلاحية النشر.',
    'supervisor-credentials-required': 'تعذر التحقق من حساب المشرف.',
    'announcement-subjects-load-failed': 'تعذر تحميل المواد الدراسية.',
    'invalid-announcement': 'أدخل عنوان الإعلان ونصه أو أرفق ملفًا، ثم اختر الفئة المستهدفة.',
    'announcement-save-failed': 'تعذر حفظ الإعلان.',
    'teacher-credentials-invalid': 'انتهت صلاحية جلسة المدرس. سجّل الدخول من جديد.',
    'invalid-teacher-announcement': 'تحقق من عنوان الإعلان ونصه والمادة المختارة.',
    'announcement-delete-failed': 'تعذر حذف الإعلان.',
  };
  return messages[error ?? ''] ?? 'حدث خطأ أثناء تنفيذ الطلب. حاول مرة أخرى.';
};

const getNotificationMessage = (notification?: NotificationResult) => {
  if (!notification || notification.status === 'missing_bot_token') {
    return 'تم نشر الإعلان، لكن إشعار تيليجرام غير مهيأ على الخادم.';
  }
  if (notification.status === 'no_subscribers') {
    return 'تم نشر الإعلان. لا يوجد طلاب في هذه السنة ربطوا حساب تيليجرام وفعّلوا الإشعارات.';
  }
  if ((notification.failed ?? 0) > 0) {
    return `تم نشر الإعلان وإرسال ${notification.sent ?? 0} إشعارًا، وتعذر إرسال ${notification.failed} إشعار.`;
  }
  return `تم نشر الإعلان وإرسال الإشعار إلى ${notification.sent ?? 0} طالب.`;
};

export default function AnnouncementPanel(props: AnnouncementPanelProps) {
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [selectedYear, setSelectedYear] = useState('أولى');
  const [targetScope, setTargetScope] = useState<'year' | 'all'>('year');
  const [selectedSubject, setSelectedSubject] = useState('');
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [attachment, setAttachment] = useState<File | null>(null);
  const [attachmentPreviewUrl, setAttachmentPreviewUrl] = useState('');
  const [previewOpen, setPreviewOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [readingId, setReadingId] = useState<number | null>(null);
  const [attachmentLoadingId, setAttachmentLoadingId] = useState<number | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [notice, setNotice] = useState<{ message: string; type: 'error' | 'success' } | null>(null);

  const mode = props.mode;
  const studentId = mode === 'student' ? props.studentId : '';
  const studentPassword = mode === 'student' ? props.password : '';
  const studentYear = mode === 'student' ? props.studentYear : '';
  const supervisorUsername = mode === 'supervisor' ? props.supervisorUsername : '';
  const supervisorPassword = mode === 'supervisor' ? props.supervisorPassword : '';
  const teacherSubjects = mode === 'teacher' ? props.subjects : noSubjects;
  const teacherUsername = mode === 'teacher' ? props.username : '';
  const teacherPassword = mode === 'teacher' ? props.password : '';

  const availableSubjects = useMemo(() => {
    if (mode === 'teacher') {
      return teacherSubjects.map((label) => {
        const separator = label.lastIndexOf(' · ');
        return {
          label,
          name: separator >= 0 ? label.slice(0, separator) : label,
          year: separator >= 0 ? label.slice(separator + 3) : '',
        };
      });
    }
    return [];
  }, [mode, teacherSubjects]);

  useEffect(() => {
    if (availableSubjects.length && !availableSubjects.some((subject) => subject.label === selectedSubject)) {
      setSelectedSubject(availableSubjects[0].label);
      if (mode === 'teacher') {
        const separator = availableSubjects[0].label.lastIndexOf(' · ');
        if (separator >= 0) setSelectedYear(availableSubjects[0].label.slice(separator + 3));
      }
    }
  }, [availableSubjects, mode, selectedSubject]);

  useEffect(() => {
    if (!attachment) {
      setAttachmentPreviewUrl('');
      return;
    }
    const url = URL.createObjectURL(attachment);
    setAttachmentPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [attachment]);

  useEffect(() => {
    if (!previewOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPreviewOpen(false);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [previewOpen]);

  useEffect(() => {
    let cancelled = false;
    let loadingRequest = false;
    const load = async (initial: boolean) => {
      if (loadingRequest) return;
      loadingRequest = true;
      if (initial) setLoading(true);
      try {
        const isTeacher = mode === 'teacher';
        const response = await fetch(isTeacher ? '/api/teacher-portal' : '/api/announcements', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(isTeacher
            ? {
              action: 'list-announcements',
              username: teacherUsername,
              password: teacherPassword,
            }
            : mode === 'student' ? {
              action: 'student-list',
              studentId,
              password: studentPassword,
              studentYear,
            }
            : {
              action: 'supervisor-data',
              supervisorUsername,
              supervisorPassword,
            }),
        });
        const result = await response.json() as {
          success?: boolean;
          error?: string;
          announcements?: Announcement[];
        };
        if (!response.ok || !result.success) throw new Error(getErrorMessage(result.error));
        if (!cancelled) {
          setAnnouncements((current) => (result.announcements ?? []).map((announcement) => {
            const existing = current.find((item) => item.id === announcement.id);
            return existing?.is_read && mode === 'student' ? { ...announcement, is_read: true } : announcement;
          }));
        }
      } catch (error) {
        if (!cancelled) {
          setNotice({
            message: error instanceof Error ? error.message : 'تعذر تحميل الإعلانات.',
            type: 'error',
          });
        }
      } finally {
        if (!cancelled) setLoading(false);
        loadingRequest = false;
      }
    };
    void load(true);
    const intervalId = window.setInterval(() => void load(false), 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [mode, studentId, studentPassword, studentYear, supervisorUsername, supervisorPassword, teacherUsername, teacherPassword]);

  const markAsRead = async (announcement: Announcement) => {
    if (mode !== 'student' || announcement.is_read) return;
    setReadingId(announcement.id);
    setNotice(null);
    try {
      const response = await fetch('/api/announcements', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'mark-read',
          studentId,
          password: studentPassword,
          studentYear,
          announcementId: announcement.id,
        }),
      });
      const result = await response.json() as { success?: boolean; error?: string };
      if (!response.ok || !result.success) throw new Error(getErrorMessage(result.error));
      setAnnouncements((current) => current.map((item) => item.id === announcement.id ? { ...item, is_read: true } : item));
    } catch (error) {
      setNotice({
        message: error instanceof Error ? error.message : 'تعذر تحديث حالة قراءة الإعلان.',
        type: 'error',
      });
    } finally {
      setReadingId(null);
    }
  };

  const deleteAnnouncement = async (announcement: Announcement) => {
    if (mode === 'student' || !window.confirm(`هل تريد حذف الإعلان «${announcement.title}»؟`)) return;
    setDeletingId(announcement.id);
    setNotice(null);
    try {
      const isTeacher = mode === 'teacher';
      const response = await fetch(isTeacher ? '/api/teacher-portal' : '/api/announcements', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(isTeacher
          ? {
            action: 'delete-announcement',
            username: teacherUsername,
            password: teacherPassword,
            announcementId: announcement.id,
          }
          : {
            action: 'supervisor-delete',
            supervisorUsername,
            supervisorPassword,
            announcementId: announcement.id,
          }),
      });
      const result = await response.json() as { success?: boolean; error?: string };
      if (!response.ok || !result.success) throw new Error(getErrorMessage(result.error));
      setAnnouncements((current) => current.filter((item) => item.id !== announcement.id));
      setNotice({ message: 'تم حذف الإعلان.', type: 'success' });
    } catch (error) {
      setNotice({
        message: error instanceof Error ? error.message : 'تعذر حذف الإعلان.',
        type: 'error',
      });
    } finally {
      setDeletingId(null);
    }
  };

  const loadAttachment = async (announcement: Announcement) => {
    if (mode !== 'student' || announcement.attachment_url) return;
    setAttachmentLoadingId(announcement.id);
    setNotice(null);
    try {
      const response = await fetch('/api/announcements', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'attachment-url',
          studentId,
          password: studentPassword,
          studentYear,
          announcementId: announcement.id,
        }),
      });
      const result = await response.json() as { success?: boolean; error?: string; url?: string };
      if (!response.ok || !result.success || !result.url) throw new Error(getErrorMessage(result.error));
      setAnnouncements((current) => current.map((item) =>
        item.id === announcement.id ? { ...item, attachment_url: result.url } : item
      ));
    } catch (error) {
      setNotice({
        message: error instanceof Error ? error.message : 'تعذر تحميل المرفق.',
        type: 'error',
      });
    } finally {
      setAttachmentLoadingId(null);
    }
  };

  const submitAnnouncement = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (mode === 'student') return;
    setSaving(true);
    setNotice(null);
    try {
      const formData = new FormData();
      formData.set('action', mode === 'teacher' ? 'create-announcement' : 'create-supervisor');
      formData.set('title', title.trim());
      formData.set('content', content.trim());
      if (attachment) formData.set('attachment', attachment);
      if (mode === 'teacher') {
        formData.set('username', teacherUsername);
        formData.set('password', teacherPassword);
        formData.set('subject', selectedSubject);
      } else {
        formData.set('supervisorUsername', supervisorUsername);
        formData.set('supervisorPassword', supervisorPassword);
        formData.set('targetScope', targetScope);
        formData.set('studentYear', targetScope === 'year' ? selectedYear : '');
      }

      const response = await fetch(mode === 'teacher' ? '/api/teacher-portal' : '/api/announcements', {
        method: 'POST',
        body: formData,
      });
      const result = await response.json() as {
        success?: boolean;
        error?: string;
        announcement?: Announcement;
        notification?: NotificationResult;
      };
      if (!response.ok || !result.success) throw new Error(getErrorMessage(result.error));
      setTitle('');
      setContent('');
      setAttachment(null);
      setPreviewOpen(false);
      if (result.announcement) {
        setAnnouncements((current) => [result.announcement as Announcement, ...current]);
      }
      setNotice({ message: getNotificationMessage(result.notification), type: 'success' });
    } catch (error) {
      setNotice({
        message: error instanceof Error ? error.message : 'تعذر نشر الإعلان.',
        type: 'error',
      });
    } finally {
      setSaving(false);
    }
  };

  if (props.mode === 'student') {
    const sortedAnnouncements = announcements.slice().sort((first, second) =>
      Number(Boolean(first.is_read)) - Number(Boolean(second.is_read))
      || new Date(second.created_at).getTime() - new Date(first.created_at).getTime()
    );
    return (
      <section className="announcement-panel" aria-labelledby="student-announcements-heading">
        <header className="announcement-heading">
          <div>
            <h2 id="student-announcements-heading">الإعلانات</h2>
            <p>إعلانات السنة الدراسية الخاصة بك، والإعلانات غير المقروءة تظهر أولًا.</p>
          </div>
          <strong>{announcements.filter((announcement) => !announcement.is_read).length} غير مقروء</strong>
        </header>
        {notice && <p className={`announcement-notice ${notice.type}`} role={notice.type === 'error' ? 'alert' : 'status'}>{notice.message}</p>}
        {loading ? <p className="announcement-empty">جارٍ تحميل الإعلانات...</p> : sortedAnnouncements.length ? (
          <div className="announcement-list">
            {sortedAnnouncements.map((announcement) => (
              <article className={`announcement-card${announcement.is_read ? '' : ' unread'}`} key={announcement.id}>
                <header>
                  <div>
                    <h3>{announcement.title}</h3>
                    <p className="announcement-author">
                      {announcement.author_type === 'admin'
                        ? 'إعلان بواسطة الإدارة'
                        : `إعلان بواسطة المدرس ${announcement.author_name}`}
                    </p>
                  </div>
                  {!announcement.is_read && <span className="announcement-unread-label">جديد</span>}
                </header>
                <p className="announcement-content">{announcement.content}</p>
                {announcement.attachment_name && (
                  <div className="announcement-attachment">
                    {announcement.attachment_url && announcement.attachment_type?.startsWith('image/') && (
                      <a href={announcement.attachment_url} target="_blank" rel="noreferrer">
                        <Image src={announcement.attachment_url} alt={announcement.attachment_name} width={560} height={420} unoptimized />
                      </a>
                    )}
                    {announcement.attachment_url ? (
                      <a href={announcement.attachment_url} target="_blank" rel="noreferrer" download={announcement.attachment_name}>
                        {announcement.attachment_name}
                      </a>
                    ) : (
                      <button type="button" onClick={() => void loadAttachment(announcement)} disabled={attachmentLoadingId === announcement.id}>
                        {attachmentLoadingId === announcement.id ? 'جارٍ تحميل المرفق...' : `فتح المرفق: ${announcement.attachment_name}`}
                      </button>
                    )}
                  </div>
                )}
                <footer>
                  <span>{announcement.subject || 'إعلان عام'} · {announcement.target_scope === 'all' ? 'كل السنوات' : `السنة ${announcement.student_year}`}</span>
                  <time dateTime={announcement.created_at}>{formatDate(announcement.created_at)}</time>
                </footer>
                {!announcement.is_read && (
                  <button type="button" onClick={() => void markAsRead(announcement)} disabled={readingId === announcement.id}>
                    {readingId === announcement.id ? 'جارٍ التحديث...' : 'تمييز كمقروء'}
                  </button>
                )}
              </article>
            ))}
          </div>
        ) : <p className="announcement-empty">لا توجد إعلانات لسنتك الدراسية حاليًا.</p>}
      </section>
    );
  }

  const isSupervisor = mode === 'supervisor';
  const currentTeacherSubject = mode === 'teacher'
    ? availableSubjects.find((subject) => subject.label === selectedSubject)
    : undefined;
  return (
    <section className="announcement-panel" aria-labelledby="announcement-management-heading">
      <header className="announcement-heading">
        <div>
          <h2 id="announcement-management-heading">{isSupervisor ? 'إدارة الإعلانات' : 'نشر إعلان للطلاب'}</h2>
          <p>{isSupervisor ? 'اختر سنة دراسية أو وجّه الإعلان إلى جميع السنوات.' : 'سيظهر الإعلان لطلاب السنة المرتبطة بالمادة المختارة. يمكنك حذف إعلاناتك من القائمة.'}</p>
        </div>
        {mode === 'supervisor' && <button type="button" className="announcement-back" onClick={props.onBack}>العودة للوظائف</button>}
      </header>
      {notice && <p className={`announcement-notice ${notice.type}`} role={notice.type === 'error' ? 'alert' : 'status'}>{notice.message}</p>}
      <form className="announcement-form" onSubmit={(event) => void submitAnnouncement(event)}>
        {isSupervisor && (
          <label>
            <span>الفئة المستهدفة</span>
            <select value={targetScope === 'all' ? 'all' : selectedYear} onChange={(event) => {
              const value = event.target.value;
              if (value === 'all') setTargetScope('all');
              else {
                setSelectedYear(value);
                setTargetScope('year');
              }
            }}>
              <option value="أولى">طلاب السنة الأولى</option>
              <option value="ثانية">طلاب السنة الثانية</option>
              <option value="all">كل السنوات</option>
            </select>
          </label>
        )}
        {mode === 'teacher' ? (
          <label>
            <span>المادة والسنة</span>
            <select
              value={selectedSubject}
              onChange={(event) => {
                setSelectedSubject(event.target.value);
                const subject = availableSubjects.find((item) => item.label === event.target.value);
                if (subject?.year) setSelectedYear(subject.year);
              }}
              required
            >
              <option value="">اختر المادة</option>
              {availableSubjects.map((subject) => <option key={subject.label} value={subject.label}>{subject.label}</option>)}
            </select>
          </label>
        ) : null}
        <label>
          <span>عنوان الإعلان</span>
          <input value={title} onChange={(event) => setTitle(event.target.value)} minLength={3} maxLength={160} required />
        </label>
        <label className="announcement-form-content">
          <span>نص الإعلان الكامل</span>
          <textarea value={content} onChange={(event) => setContent(event.target.value)} maxLength={4000} rows={5} />
        </label>
        <label className="announcement-form-content">
          <span>مرفق (صورة أو PDF أو Word أو TXT، حتى 5 ميغابايت)</span>
          <input
            type="file"
            accept="image/jpeg,image/png,image/gif,image/webp,application/pdf,text/plain,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            onChange={(event) => setAttachment(event.target.files?.[0] ?? null)}
          />
          {attachment && <span className="announcement-file-name">{attachment.name}</span>}
        </label>
        <div className="announcement-form-actions">
          <button type="button" className="announcement-preview-button" onClick={() => setPreviewOpen(true)} disabled={!title.trim() || (!content.trim() && !attachment)}>
            معاينة الإعلان
          </button>
          <button type="submit" disabled={saving || loading || (mode === 'teacher' && (!selectedSubject || !currentTeacherSubject))}>
          {saving ? 'جارٍ النشر...' : 'نشر الإعلان وإرسال إشعار'}
          </button>
        </div>
      </form>
      {previewOpen && (
        <div className="announcement-preview-backdrop" onClick={() => setPreviewOpen(false)}>
          <section
            className="announcement-preview-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="announcement-preview-heading"
            onClick={(event) => event.stopPropagation()}
          >
            <header>
              <h3 id="announcement-preview-heading">معاينة الإعلان</h3>
              <button type="button" onClick={() => setPreviewOpen(false)} aria-label="إغلاق المعاينة">إغلاق</button>
            </header>
            <article className="announcement-card">
              <h3>{title}</h3>
              <p className="announcement-author">
                {isSupervisor ? 'إعلان بواسطة الإدارة' : `إعلان بواسطة المدرس ${props.mode === 'teacher' ? props.username : ''}`}
              </p>
              {content && <p className="announcement-content">{content}</p>}
              {attachment && attachmentPreviewUrl && (
                <div className="announcement-preview-attachment">
                  {attachment.type.startsWith('image/') ? (
                    <Image src={attachmentPreviewUrl} alt={`معاينة ${attachment.name}`} width={560} height={420} unoptimized />
                  ) : attachment.type === 'application/pdf' ? (
                    <iframe src={attachmentPreviewUrl} title={`معاينة ${attachment.name}`} />
                  ) : (
                    <span>{attachment.name}</span>
                  )}
                  <a href={attachmentPreviewUrl} download={attachment.name}>فتح أو تنزيل المرفق</a>
                </div>
              )}
              <footer>
                <span>{mode === 'teacher'
                  ? currentTeacherSubject?.label
                  : targetScope === 'all' ? 'كل السنوات' : `السنة ${selectedYear}`}</span>
              </footer>
            </article>
          </section>
        </div>
      )}
      {mode !== 'student' && (
        <div className="announcement-list">
          {loading ? <p className="announcement-empty">جارٍ تحميل الإعلانات...</p> : announcements.map((announcement) => (
            <article className="announcement-card" key={announcement.id}>
              <header>
                <div>
                  <h3>{announcement.title}</h3>
                  <p className="announcement-author">
                    {announcement.author_type === 'admin' ? 'إعلان بواسطة الإدارة' : `إعلان بواسطة المدرس ${announcement.author_name}`}
                  </p>
                </div>
              </header>
              <p className="announcement-content">{announcement.content}</p>
              <footer>
                <span>{announcement.subject || 'إعلان عام'} · {announcement.target_scope === 'all' ? 'كل السنوات' : `السنة ${announcement.student_year}`}</span>
                <time dateTime={announcement.created_at}>{formatDate(announcement.created_at)}</time>
                <button
                  type="button"
                  className="announcement-preview-button"
                  onClick={() => void deleteAnnouncement(announcement)}
                  disabled={deletingId === announcement.id}
                  aria-label={`حذف الإعلان ${announcement.title}`}
                >
                  <Trash2 size={15} /> {deletingId === announcement.id ? 'جارٍ الحذف...' : 'حذف'}
                </button>
              </footer>
            </article>
          ))}
          {!loading && !announcements.length && <p className="announcement-empty">لا توجد إعلانات منشورة.</p>}
        </div>
      )}
    </section>
  );
}
