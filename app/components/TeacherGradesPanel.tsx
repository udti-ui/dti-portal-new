'use client';

import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { Award, Download, FileUp, Pencil, Save, Trash2, X } from 'lucide-react';

type TeacherStudent = {
  id: string;
  fullName: string;
};

type GradeSettings = {
  includeCard: boolean;
  includeActivity: boolean;
  includeTheoryStudy: boolean;
  includePracticalStudy: boolean;
  includeTheoryExam: boolean;
  includePracticalExam: boolean;
  maxCard: number;
  maxActivity: number;
  maxTheoryStudy: number;
  maxPracticalStudy: number;
  maxTheoryExam: number;
  maxPracticalExam: number;
};
type GradeCeiling = 'maxCard' | 'maxActivity' | 'maxTheoryStudy' | 'maxPracticalStudy' | 'maxTheoryExam' | 'maxPracticalExam';

type GradeComponent = 'card' | 'activity' | 'theoryStudy' | 'practicalStudy' | 'theoryExam' | 'practicalExam';
type GradeRecord = {
  id: number | string;
  subject: string;
  student_id: string;
  component: GradeComponent;
  score: number;
  max_score: number;
  updated_at: string;
};
type GradeImportReport = {
  imported: number;
  missing: Array<{ component: GradeComponent; names: string[] }>;
  unmatched: string[];
  exceeded: Array<{ component: GradeComponent; entries: string[] }>;
  invalid: Array<{ component: GradeComponent; entries: string[] }>;
};

const defaultSettings: GradeSettings = {
  includeCard: true,
  includeActivity: true,
  includeTheoryStudy: false,
  includePracticalStudy: false,
  includeTheoryExam: true,
  includePracticalExam: false,
  maxCard: 10,
  maxActivity: 10,
  maxTheoryStudy: 20,
  maxPracticalStudy: 20,
  maxTheoryExam: 100,
  maxPracticalExam: 100,
};

const componentLabels: Record<GradeComponent, string> = {
  card: 'علامة البطاقة',
  activity: 'علامة النشاط',
  theoryStudy: 'مذاكرة نظرية',
  practicalStudy: 'مذاكرة عملية',
  theoryExam: 'امتحان نظري',
  practicalExam: 'امتحان عملي',
};

const componentOptions: Array<{ key: GradeComponent; includeKey: keyof Pick<
  GradeSettings,
  'includeCard' | 'includeActivity' | 'includeTheoryStudy' | 'includePracticalStudy' | 'includeTheoryExam' | 'includePracticalExam'
> }> = [
  { key: 'card', includeKey: 'includeCard' },
  { key: 'activity', includeKey: 'includeActivity' },
  { key: 'theoryStudy', includeKey: 'includeTheoryStudy' },
  { key: 'practicalStudy', includeKey: 'includePracticalStudy' },
  { key: 'theoryExam', includeKey: 'includeTheoryExam' },
  { key: 'practicalExam', includeKey: 'includePracticalExam' },
];

const getComponentMaximum = (settings: GradeSettings, component: GradeComponent) => {
  switch (component) {
    case 'card': return settings.maxCard;
    case 'activity': return settings.maxActivity;
    case 'theoryStudy': return settings.maxTheoryStudy;
    case 'practicalStudy': return settings.maxPracticalStudy;
    case 'theoryExam': return settings.maxTheoryExam;
    case 'practicalExam': return settings.maxPracticalExam;
  }
};

const getSettings = (row: Record<string, unknown>): GradeSettings => ({
  includeCard: typeof row.include_card === 'boolean' ? row.include_card : true,
  includeActivity: typeof row.include_activity === 'boolean' ? row.include_activity : true,
  includeTheoryStudy: typeof row.include_theory_study === 'boolean' ? row.include_theory_study : row.has_studies === true,
  includePracticalStudy: typeof row.include_practical_study === 'boolean'
    ? row.include_practical_study
    : row.has_studies === true && row.has_practical === true,
  includeTheoryExam: typeof row.include_theory_exam === 'boolean' ? row.include_theory_exam : true,
  includePracticalExam: typeof row.include_practical_exam === 'boolean' ? row.include_practical_exam : row.has_practical === true,
  maxCard: Number(row.max_card),
  maxActivity: Number(row.max_activity),
  maxTheoryStudy: Number(row.max_theory_study),
  maxPracticalStudy: Number(row.max_practical_study),
  maxTheoryExam: Number(row.max_theory_exam),
  maxPracticalExam: Number(row.max_practical_exam),
});

export default function TeacherGradesPanel({
  username,
  password,
  selectedSubject,
  students,
}: {
  username: string;
  password: string;
  selectedSubject: string;
  students: TeacherStudent[];
}) {
  const [settingsBySubject, setSettingsBySubject] = useState<Record<string, GradeSettings>>({});
  const [grades, setGrades] = useState<GradeRecord[]>([]);
  const [selectedStudent, setSelectedStudent] = useState('');
  const [selectedComponent, setSelectedComponent] = useState<GradeComponent>('card');
  const [score, setScore] = useState('');
  const [loading, setLoading] = useState(true);
  const [savingSettings, setSavingSettings] = useState(false);
  const [savingGrade, setSavingGrade] = useState(false);
  const [importingGrades, setImportingGrades] = useState(false);
  const [deletingGrade, setDeletingGrade] = useState<string | null>(null);
  const [deletingGroup, setDeletingGroup] = useState(false);
  const [editingGrade, setEditingGrade] = useState<{ studentId: string; component: GradeComponent } | null>(null);
  const [gradeImportReport, setGradeImportReport] = useState<GradeImportReport | null>(null);
  const [notice, setNotice] = useState<{ message: string; type: 'error' | 'success' } | null>(null);
  const [templateComponents, setTemplateComponents] = useState<GradeComponent[] | null>(null);

  const request = useCallback(async (payload: Record<string, unknown>) => {
    const response = await fetch('/api/teacher-portal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, username, password }),
    });
    const result = await response.json() as Record<string, unknown> & { success?: boolean; error?: string };
    if (!response.ok || !result.success) {
      const errors: Record<string, string> = {
        'teacher-grades-schema-not-configured': 'يجب تشغيل ملف supabase-teacher-grades.sql بعد إعداد المواد الأكاديمية.',
        'teacher-grades-load-failed': 'تعذر تحميل بيانات العلامات.',
        'invalid-grade-settings': 'أدخل سقفاً صحيحاً أكبر من صفر لكل مكوّن مفعّل.',
        'teacher-grade-settings-save-failed': 'تعذر حفظ إعدادات المادة.',
        'teacher-grade-settings-required': 'احفظ إعدادات المادة أولاً قبل إدخال العلامات.',
        'grade-component-disabled': 'هذا المكوّن غير مفعّل في إعدادات المادة.',
        'grade-exceeds-maximum': 'العلامة المدخلة تتجاوز السقف المحدد للمكوّن.',
        'invalid-grade': 'تحقق من الطالب والمكوّن والعلامة المدخلة.',
        'student-year-mismatch': 'الطالب لا ينتمي إلى سنة المادة المحددة.',
        'teacher-grade-save-failed': 'تعذر حفظ العلامة.',
        'invalid-grade-import': 'ملف العلامات غير صالح. تأكد من وجود الرقم الجامعي والعلامة وعدم تكرار الرقم.',
        'grade-import-students-unmatched': 'توجد أرقام جامعية لا تطابق طلاب المادة.',
        'invalid-grade-delete': 'تعذر تحديد العلامة المطلوب حذفها.',
        'teacher-grade-delete-failed': 'تعذر حذف العلامة.',
      };
      throw new Error(errors[result.error ?? ''] ?? 'حدث خطأ أثناء تنفيذ الطلب. حاول مرة أخرى.');
    }
    return result;
  }, [username, password]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setNotice(null);
    void request({ action: 'list-grades' })
      .then((result) => {
        if (!active) return;
        const settingsRows = Array.isArray(result.settings) ? result.settings as Array<Record<string, unknown>> : [];
        const gradeRows = Array.isArray(result.grades) ? result.grades as GradeRecord[] : [];
        setSettingsBySubject(Object.fromEntries(settingsRows
          .filter((row) => typeof row.subject === 'string' && row.subject)
          .map((row) => [String(row.subject), getSettings(row)])));
        setGrades(gradeRows);
      })
      .catch((error: unknown) => {
        if (active) setNotice({ message: error instanceof Error ? error.message : 'تعذر تحميل العلامات.', type: 'error' });
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [request]);

  useEffect(() => {
    setSelectedStudent('');
    setScore('');
    setEditingGrade(null);
  }, [selectedSubject]);

  const settings = settingsBySubject[selectedSubject] ?? defaultSettings;
  const availableComponents = useMemo(() => ([
    { key: 'card' as const, visible: settings.includeCard },
    { key: 'activity' as const, visible: settings.includeActivity },
    { key: 'theoryStudy' as const, visible: settings.includeTheoryStudy },
    { key: 'practicalStudy' as const, visible: settings.includePracticalStudy },
    { key: 'theoryExam' as const, visible: settings.includeTheoryExam },
    { key: 'practicalExam' as const, visible: settings.includePracticalExam },
  ]).filter((component) => component.visible), [
    settings.includeActivity,
    settings.includeCard,
    settings.includePracticalExam,
    settings.includePracticalStudy,
    settings.includeTheoryExam,
    settings.includeTheoryStudy,
  ]);
  useEffect(() => {
    if (!availableComponents.some((component) => component.key === selectedComponent)) {
      setSelectedComponent('card');
    }
    setTemplateComponents((current) => {
      const available = availableComponents.map((component) => component.key);
      if (current === null) return loading ? null : available;
      return current.filter((component) => available.includes(component));
    });
  }, [availableComponents, loading, selectedComponent]);
  const selectedTemplateComponents = templateComponents ?? availableComponents.map((component) => component.key);
  const maximum = getComponentMaximum(settings, selectedComponent);
  const visibleGrades = grades.filter((grade) => grade.subject === selectedSubject);
  const configured = Object.prototype.hasOwnProperty.call(settingsBySubject, selectedSubject);

  const updateSetting = (key: keyof GradeSettings, value: boolean | number) => {
    setSettingsBySubject((current) => ({
      ...current,
      [selectedSubject]: { ...(current[selectedSubject] ?? defaultSettings), [key]: value },
    }));
  };

  const saveSettings = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSavingSettings(true);
    setNotice(null);
    try {
      const result = await request({ action: 'save-grade-settings', subject: selectedSubject, gradeSettings: settings });
      const saved = result.settings as Record<string, unknown>;
      setSettingsBySubject((current) => ({ ...current, [selectedSubject]: getSettings(saved) }));
      setNotice({ message: 'تم حفظ إعدادات المادة وسقوف العلامات.', type: 'success' });
    } catch (error) {
      setNotice({ message: error instanceof Error ? error.message : 'تعذر حفظ إعدادات المادة.', type: 'error' });
    } finally {
      setSavingSettings(false);
    }
  };

  const saveGrade = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const numericScore = Number(score);
    if (Number.isFinite(numericScore) && numericScore > maximum) {
      setNotice({ message: `العلامة ${numericScore} تتجاوز السقف المحدد (${maximum}) ولا يمكن حفظها.`, type: 'error' });
      return;
    }
    if (!selectedStudent || !Number.isFinite(numericScore) || numericScore < 0) {
      setNotice({ message: `أدخل علامة بين 0 و${maximum}.`, type: 'error' });
      return;
    }
    setSavingGrade(true);
    setNotice(null);
    try {
      const result = await request({
        action: 'save-grade',
        subject: selectedSubject,
        studentId: selectedStudent,
        gradeComponent: selectedComponent,
        gradeScore: numericScore,
      });
      const saved = result.grade as GradeRecord;
      const grade = { ...saved, subject: selectedSubject };
      setGrades((current) => [
        grade,
        ...current.filter((item) => !(item.subject === grade.subject
          && item.student_id === grade.student_id && item.component === grade.component)),
      ]);
      setScore('');
      setEditingGrade(null);
      setNotice({ message: editingGrade ? 'تم تعديل العلامة بنجاح.' : 'تم حفظ العلامة بنجاح.', type: 'success' });
    } catch (error) {
      setNotice({ message: error instanceof Error ? error.message : 'تعذر حفظ العلامة.', type: 'error' });
    } finally {
      setSavingGrade(false);
    }
  };

  const beginEditGrade = (grade: GradeRecord) => {
    setSelectedStudent(grade.student_id);
    setSelectedComponent(grade.component);
    setScore(String(grade.score));
    setEditingGrade({ studentId: grade.student_id, component: grade.component });
    document.getElementById('teacher-grade-entry')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  const cancelEditGrade = () => {
    setEditingGrade(null);
    setSelectedStudent('');
    setScore('');
  };

  const deleteOneGrade = async (grade: GradeRecord) => {
    const studentName = students.find((student) => student.id === grade.student_id)?.fullName ?? grade.student_id;
    if (!window.confirm(`هل تريد حذف ${componentLabels[grade.component]} للطالب ${studentName}؟`)) return;
    const key = `${grade.student_id}:${grade.component}`;
    setDeletingGrade(key);
    setNotice(null);
    try {
      await request({
        action: 'delete-grade',
        subject: selectedSubject,
        studentId: grade.student_id,
        gradeComponent: grade.component,
      });
      setGrades((current) => current.filter((item) => !(item.subject === selectedSubject
        && item.student_id === grade.student_id && item.component === grade.component)));
      if (editingGrade?.studentId === grade.student_id && editingGrade.component === grade.component) cancelEditGrade();
      setNotice({ message: 'تم حذف العلامة.', type: 'success' });
    } catch (error) {
      setNotice({ message: error instanceof Error ? error.message : 'تعذر حذف العلامة.', type: 'error' });
    } finally {
      setDeletingGrade(null);
    }
  };

  const deleteGradeGroup = async (scope: 'component' | 'subject') => {
    const targetGrades = scope === 'subject'
      ? visibleGrades
      : visibleGrades.filter((grade) => grade.component === selectedComponent);
    if (!targetGrades.length) {
      setNotice({ message: 'لا توجد علامات لحذفها.', type: 'error' });
      return;
    }
    const targetName = scope === 'subject' ? `كل علامات مادة ${selectedSubject}` : `كل علامات ${componentLabels[selectedComponent]} في مادة ${selectedSubject}`;
    if (!window.confirm(`تنبيه: سيتم حذف ${targetGrades.length} علامة نهائياً. ${targetName}. هل تريد المتابعة؟`)) return;
    setDeletingGroup(true);
    setNotice(null);
    try {
      const result = await request({
        action: 'delete-grades',
        subject: selectedSubject,
        gradeDeleteScope: scope,
        ...(scope === 'component' ? { gradeComponent: selectedComponent } : {}),
      });
      const deletedCount = Number(result.deletedCount ?? 0);
      setGrades((current) => current.filter((grade) => scope === 'subject'
        ? grade.subject !== selectedSubject
        : !(grade.subject === selectedSubject && grade.component === selectedComponent)));
      if (scope === 'subject' || editingGrade?.component === selectedComponent) cancelEditGrade();
      setNotice({ message: `تم حذف ${deletedCount} علامة.`, type: 'success' });
    } catch (error) {
      setNotice({ message: error instanceof Error ? error.message : 'تعذر حذف العلامات.', type: 'error' });
    } finally {
      setDeletingGroup(false);
    }
  };

  const downloadGradeTemplate = async () => {
    if (!students.length) {
      setNotice({ message: 'لا يوجد طلاب في المادة لإنشاء القالب.', type: 'error' });
      return;
    }
    if (!selectedTemplateComponents.length) {
      setNotice({ message: 'اختر مكوّناً واحداً على الأقل لإضافته إلى ملف العلامات.', type: 'error' });
      return;
    }
    try {
      const ExcelJS = await import('exceljs');
      const workbook = new ExcelJS.Workbook();
      const downloadDate = new Date();
      const formattedDate = downloadDate.toLocaleDateString('ar-SY');
      const worksheet = workbook.addWorksheet('العلامات', {
        views: [{ state: 'frozen', ySplit: 3, rightToLeft: true }],
      });
      const columns = [
        { header: 'التسلسل', key: 'sequence', width: 12 },
        { header: 'الرقم الجامعي', key: 'studentId', width: 20, style: { numFmt: '@' } },
        { header: 'اسم الطالب', key: 'fullName', width: 34 },
        ...selectedTemplateComponents.map((component) => ({
          header: `${componentLabels[component]} (السقف ${getComponentMaximum(settings, component)})`,
          key: component,
          width: 24,
        })),
      ];
      worksheet.columns = columns;
      const lastColumn = columns.length;
      worksheet.mergeCells(1, 1, 1, lastColumn);
      worksheet.getCell(1, 1).value = `المادة: ${selectedSubject}`;
      worksheet.mergeCells(2, 1, 2, lastColumn);
      worksheet.getCell(2, 1).value = `تاريخ تنزيل الملف: ${formattedDate}`;
      worksheet.getRow(1).height = 28;
      worksheet.getRow(2).height = 24;
      [worksheet.getRow(1), worksheet.getRow(2)].forEach((row) => {
        row.font = { name: 'Arial', bold: true, color: { argb: 'FF134E4A' }, size: 12 };
        row.alignment = { horizontal: 'right', vertical: 'middle' };
      });
      const headerRow = worksheet.getRow(3);
      columns.forEach((column, index) => {
        headerRow.getCell(index + 1).value = column.header;
      });
      headerRow.height = 32;
      const header = headerRow;
      header.font = { name: 'Arial', bold: true, color: { argb: 'FFFFFFFF' } };
      header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F766E' } };
      header.alignment = { horizontal: 'center', vertical: 'middle' };
      const existingGrades = new Map(visibleGrades.map((grade) => [`${grade.student_id}:${grade.component}`, grade.score]));
      worksheet.addRows(students.map((student, index) => ({
        sequence: index + 1,
        studentId: student.id,
        fullName: student.fullName,
        ...Object.fromEntries(selectedTemplateComponents.map((component) => [
          component,
          existingGrades.get(`${student.id}:${component}`) ?? null,
        ])),
      })));
      worksheet.autoFilter = { from: { row: 3, column: 1 }, to: { row: 3, column: lastColumn } };
      worksheet.eachRow((row, rowNumber) => {
        if (rowNumber <= 3) return;
        row.eachCell((cell) => {
          cell.alignment = { horizontal: 'right', vertical: 'middle' };
          if (rowNumber % 2 === 0) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F7F6' } };
        });
      });
      const buffer = await workbook.xlsx.writeBuffer();
      const url = URL.createObjectURL(new Blob([buffer], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      }));
      const link = document.createElement('a');
      link.href = url;
      const dateFilePart = `${downloadDate.getFullYear()}-${String(downloadDate.getMonth() + 1).padStart(2, '0')}-${String(downloadDate.getDate()).padStart(2, '0')}`;
      link.download = `${selectedSubject}-${dateFilePart}-العلامات.xlsx`.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-');
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      console.error('Teacher grade template export failed:', error);
      setNotice({ message: 'تعذر إنشاء ملف Excel. حاول مرة أخرى.', type: 'error' });
    }
  };

  const importGradeFile = async (file: File) => {
    setImportingGrades(true);
    setNotice(null);
    setGradeImportReport(null);
    try {
      const ExcelJS = await import('exceljs');
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(await file.arrayBuffer());
      const worksheet = workbook.worksheets[0];
      if (!worksheet || worksheet.rowCount < 1) throw new Error('ملف Excel فارغ.');

      const normalizeHeader = (value: unknown) => String(value ?? '')
        .trim()
        .replace(/[إأآ]/g, 'ا')
        .replace(/[()：:]/g, '')
        .replace(/[ًٌٍَُِّْ]/g, '')
        .replace(/\s+/g, '')
        .toLocaleLowerCase();
      let headerRowNumber = 0;
      let studentIdColumn = 0;
      const componentColumns = new Map<GradeComponent, number>();
      const headerAliases: Partial<Record<GradeComponent, string[]>> = {
        theoryStudy: ['العلامةالمذاكرة', 'علامةالمذاكرة', 'مذاكرةنظري'],
      };
      for (let rowNumber = 1; rowNumber <= Math.min(10, worksheet.rowCount); rowNumber += 1) {
        const foundColumns = new Map<GradeComponent, number>();
        let foundStudentIdColumn = 0;
        worksheet.getRow(rowNumber).eachCell((cell, columnNumber) => {
          const header = normalizeHeader(cell.value);
          if (['الرقمالجامعي', 'studentid', 'student_id'].includes(header)) {
            foundStudentIdColumn = columnNumber;
          }
          availableComponents.forEach(({ key }) => {
            const label = normalizeHeader(componentLabels[key]);
            const aliases = (headerAliases[key] ?? []).map(normalizeHeader);
            if (header.includes(label) || aliases.some((alias) => header.includes(alias))) {
              foundColumns.set(key, columnNumber);
            }
          });
        });
        if (foundStudentIdColumn && foundColumns.size) {
          headerRowNumber = rowNumber;
          studentIdColumn = foundStudentIdColumn;
          foundColumns.forEach((column, component) => componentColumns.set(component, column));
          break;
        }
      }
      if (!headerRowNumber || !componentColumns.size) {
        throw new Error('لم يتم العثور على صف عناوين يتضمن الرقم الجامعي وعمود علامة معروفاً.');
      }

      const roster = new Map(students.map((student) => [student.id, student]));
      const entriesByComponent = new Map<GradeComponent, Map<string, number>>();
      const enteredByComponent = new Map<GradeComponent, Set<string>>();
      const exceeded: GradeImportReport['exceeded'] = [];
      const invalid: GradeImportReport['invalid'] = [];
      componentColumns.forEach((_, component) => {
        entriesByComponent.set(component, new Map());
        enteredByComponent.set(component, new Set());
      });
      const unmatchedIds = new Set<string>();
      const duplicateIds = new Set<string>();
      const seenIds = new Set<string>();
      worksheet.eachRow((row, rowNumber) => {
        if (rowNumber <= headerRowNumber) return;
        const studentId = String(row.getCell(studentIdColumn).text ?? '').trim();
        if (!studentId) return;
        if (!roster.has(studentId)) {
          unmatchedIds.add(studentId);
          return;
        }
        if (seenIds.has(studentId)) {
          duplicateIds.add(studentId);
          return;
        }
        seenIds.add(studentId);
        componentColumns.forEach((column, component) => {
          const rawScore = row.getCell(column).value;
          if (rawScore === null || rawScore === undefined || String(rawScore).trim() === '') {
            return;
          }
          enteredByComponent.get(component)?.add(studentId);
          const numericScore = typeof rawScore === 'number' ? rawScore : Number(String(rawScore).replace(',', '.').trim());
          const studentName = roster.get(studentId)?.fullName ?? studentId;
          if (!Number.isFinite(numericScore) || numericScore < 0) {
            const report = invalid.find((item) => item.component === component);
            if (report) report.entries.push(`${studentName}: ${String(rawScore)}`);
            else invalid.push({ component, entries: [`${studentName}: ${String(rawScore)}`] });
          } else if (numericScore > getComponentMaximum(settings, component)) {
            const report = exceeded.find((item) => item.component === component);
            const entry = `${studentName}: ${numericScore} (السقف ${getComponentMaximum(settings, component)})`;
            if (report) report.entries.push(entry);
            else exceeded.push({ component, entries: [entry] });
          } else {
            entriesByComponent.get(component)?.set(studentId, numericScore);
          }
        });
      });
      if (duplicateIds.size) {
        throw new Error(`يوجد تكرار في الرقم الجامعي: ${[...duplicateIds].join('، ')}`);
      }

      const missing = [...componentColumns.keys()].flatMap((component) => {
        const enteredIds = enteredByComponent.get(component) ?? new Set<string>();
        const names = students.filter((student) => !enteredIds.has(student.id)).map((student) => student.fullName);
        return names.length ? [{ component, names }] : [];
      });
      const unmatched = [...unmatchedIds];
      const savedGrades: GradeRecord[] = [];
      const gradeBatches = [...entriesByComponent].flatMap(([component, entries]) =>
        entries.size ? [{ component, entries: [...entries].map(([studentId, importedScore]) => ({ studentId, score: importedScore })) }] : []);
      if (gradeBatches.length) {
        const result = await request({
          action: 'bulk-save-grade-sheet',
          subject: selectedSubject,
          gradeBatches,
        });
        savedGrades.push(...(Array.isArray(result.grades) ? result.grades as GradeRecord[] : []));
      }
      setGrades((current) => {
        const updated = new Map(current.map((grade) => [`${grade.student_id}:${grade.component}:${grade.subject}`, grade]));
        savedGrades.forEach((grade) => updated.set(`${grade.student_id}:${grade.component}:${grade.subject}`, grade));
        return [...updated.values()];
      });
      setGradeImportReport({ imported: savedGrades.length, missing, unmatched, exceeded, invalid });
      setNotice({
        message: savedGrades.length
          ? `تم تحميل ${savedGrades.length} علامة في ${gradeBatches.length} مكوّناً${missing.length ? `، ويوجد خانات فارغة في ${missing.length} مكوّنات` : ''}.`
          : 'لم توجد علامات مدخلة في الملف؛ لم يتم حفظ أي علامة.',
        type: 'success',
      });
    } catch (error) {
      setNotice({ message: error instanceof Error ? error.message : 'تعذر قراءة ملف العلامات.', type: 'error' });
    } finally {
      setImportingGrades(false);
    }
  };

  if (!selectedSubject) {
    return <section className="teacher-panel"><p>لا توجد مادة مسندة لهذا الحساب.</p></section>;
  }

  return (
    <div className="teacher-grades-page">
      {notice && <div className={`teacher-portal-notice ${notice.type}`} role={notice.type === 'error' ? 'alert' : 'status'}>{notice.message}</div>}
      <section className="teacher-panel teacher-grade-settings">
        <div className="teacher-panel-heading">
          <div>
            <h2>إعدادات العلامات — {selectedSubject}</h2>
            <p>حدد مكوّنات المادة وأسقف العلامات قبل البدء بالإدخال.</p>
          </div>
          {loading && <span>جارٍ تحميل العلامات...</span>}
        </div>
        <form onSubmit={(event) => void saveSettings(event)}>
          <div className="teacher-grade-options">
            {componentOptions.map(({ key, includeKey }) => (
              <label key={key}>
                <input
                  type="checkbox"
                  checked={settings[includeKey]}
                  onChange={(event) => updateSetting(includeKey, event.target.checked)}
                />
                {componentLabels[key]}
              </label>
            ))}
          </div>
          <div className="teacher-grade-settings-grid">
            {componentOptions.filter(({ includeKey }) => settings[includeKey]).map(({ key }) => {
              const ceilingKey = {
                card: 'maxCard',
                activity: 'maxActivity',
                theoryStudy: 'maxTheoryStudy',
                practicalStudy: 'maxPracticalStudy',
                theoryExam: 'maxTheoryExam',
                practicalExam: 'maxPracticalExam',
              }[key] as GradeCeiling;
              return (
                <label key={key}>
                  <span>سقف {componentLabels[key]}</span>
                  <input
                    type="number"
                    min="0.01"
                    step="0.01"
                    required
                    value={settings[ceilingKey]}
                    onChange={(event) => updateSetting(ceilingKey, Number(event.target.value))}
                  />
                </label>
              );
            })}
          </div>
          <button type="submit" className="teacher-grade-save-button" disabled={savingSettings || loading}>
            <Save size={16} aria-hidden="true" /> {savingSettings ? 'جارٍ الحفظ...' : configured ? 'حفظ الإعدادات' : 'حفظ إعدادات المادة'}
          </button>
        </form>
      </section>

      <section className="teacher-panel">
        <div className="teacher-panel-heading">
          <div><h2>تحميل العلامات من Excel</h2><p>اختر المكوّنات التي تريدها في الملف، ثم نزّل قائمة الطلاب واملأ العلامات وأعد رفع الملف. المطابقة تتم بالرقم الجامعي فقط.</p></div>
        </div>
        <div className="teacher-grade-import-tools">
          <fieldset className="teacher-grade-template-components" disabled={importingGrades}>
            <legend>مكوّنات العلامة في ملف Excel</legend>
            {availableComponents.map(({ key }) => (
              <label key={key}>
                <input
                  type="checkbox"
                  checked={selectedTemplateComponents.includes(key)}
                  onChange={(event) => setTemplateComponents((current) => {
                    const selected = current ?? availableComponents.map((component) => component.key);
                    return event.target.checked
                      ? [...new Set([...selected, key])]
                      : selected.filter((component) => component !== key);
                  })}
                />
                <span>{componentLabels[key]}</span>
                <small>السقف: {getComponentMaximum(settings, key)}</small>
              </label>
            ))}
          </fieldset>
          <button type="button" className="teacher-grade-save-button" onClick={() => void downloadGradeTemplate()} disabled={!students.length || !selectedTemplateComponents.length || importingGrades}>
            <Download size={17} aria-hidden="true" /> تنزيل قائمة الطلاب
          </button>
          <label className={`teacher-grade-upload-button${!configured || importingGrades ? ' is-disabled' : ''}`}>
            <FileUp size={17} aria-hidden="true" /> {importingGrades ? 'جارٍ استيراد العلامات...' : 'رفع ملف العلامات'}
            <input
              type="file"
              accept=".xlsx,.xls"
              disabled={!configured || importingGrades}
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (file) void importGradeFile(file);
              }}
            />
          </label>
        </div>
        {!configured && <p className="teacher-grade-hint">احفظ إعدادات المادة أولاً لتفعيل رفع العلامات.</p>}
        {gradeImportReport && (
          <div className="teacher-grade-import-report" role="status">
            <strong>تم استيراد {gradeImportReport.imported} علامة.</strong>
            {gradeImportReport.missing.length > 0 && (
              gradeImportReport.missing.map((item) => (
                <div key={`missing-${item.component}`}>
                  <strong>تنبيه: لم تُسجل {componentLabels[item.component]} لـ {item.names.length} طالباً:</strong>
                  <p>{item.names.join('، ')}</p>
                </div>
              ))
            )}
            {gradeImportReport.unmatched.length > 0 && (
              <div>
                <strong>أرقام جامعية غير موجودة في قائمة المادة (تم تجاهلها):</strong>
                <p>{gradeImportReport.unmatched.join('، ')}</p>
              </div>
            )}
            {gradeImportReport.exceeded.length > 0 && (
              gradeImportReport.exceeded.map((item) => (
                <div className="teacher-grade-import-warning" key={`exceeded-${item.component}`}>
                  <strong>تنبيه: لم تُحفظ العلامات التي تجاوزت سقف {componentLabels[item.component]}:</strong>
                  <p>{item.entries.join('، ')}</p>
                </div>
              ))
            )}
            {gradeImportReport.invalid.length > 0 && (
              gradeImportReport.invalid.map((item) => (
                <div className="teacher-grade-import-warning" key={`invalid-${item.component}`}>
                  <strong>علامات {componentLabels[item.component]} غير الصالحة لم تُحفظ:</strong>
                  <p>{item.entries.join('، ')}</p>
                </div>
              ))
            )}
          </div>
        )}
      </section>

      <section className="teacher-panel">
        <div className="teacher-panel-heading">
          <div><h2>إدخال علامة</h2><p>يمكن تعديل علامة المكوّن بإدخال قيمة جديدة. كل مكوّن محفوظ بشكل مستقل.</p></div>
        </div>
        {!configured ? (
          <p className="teacher-grade-hint">احفظ إعدادات المادة أولاً لتفعيل إدخال العلامات.</p>
        ) : (
          <form id="teacher-grade-entry" className="teacher-grade-entry-form" onSubmit={(event) => void saveGrade(event)}>
            <label><span>الطالب</span>
              <select required value={selectedStudent} onChange={(event) => setSelectedStudent(event.target.value)}>
                <option value="">اختر الطالب</option>
                {students.map((student) => <option key={student.id} value={student.id}>{student.fullName} — {student.id}</option>)}
              </select>
            </label>
            <label><span>نوع العلامة</span>
              <select value={selectedComponent} onChange={(event) => setSelectedComponent(event.target.value as GradeComponent)}>
                {availableComponents.map(({ key }) => <option key={key} value={key}>{componentLabels[key]}</option>)}
              </select>
            </label>
            <label><span>العلامة (السقف {maximum})</span>
              <input type="number" min="0" max={maximum} step="0.01" required value={score} onChange={(event) => setScore(event.target.value)} />
            </label>
            <button type="submit" className="teacher-grade-save-button" disabled={savingGrade || !students.length}>
              <Award size={17} aria-hidden="true" /> {savingGrade ? 'جارٍ الحفظ...' : editingGrade ? 'حفظ التعديل' : 'حفظ العلامة'}
            </button>
            {editingGrade && <button type="button" className="teacher-grade-cancel-button" onClick={cancelEditGrade} disabled={savingGrade}>
              <X size={16} aria-hidden="true" /> إلغاء التعديل
            </button>}
          </form>
        )}
      </section>

      <section className="teacher-panel">
        <div className="teacher-panel-heading">
          <div><h2>العلامات المدخلة</h2><p>تظهر العلامات المسجلة للمادة المختارة فقط.</p></div>
          {configured && <div className="teacher-grade-delete-tools">
            <label>
              <span>حذف علامات نوع محدد</span>
              <select value={selectedComponent} onChange={(event) => setSelectedComponent(event.target.value as GradeComponent)} disabled={deletingGroup}>
                {availableComponents.map(({ key }) => <option key={key} value={key}>{componentLabels[key]}</option>)}
              </select>
            </label>
            <button type="button" className="teacher-grade-delete-button" onClick={() => void deleteGradeGroup('component')} disabled={deletingGroup || !visibleGrades.some((grade) => grade.component === selectedComponent)}>
              <Trash2 size={15} aria-hidden="true" /> حذف علامات هذا النوع
            </button>
            <button type="button" className="teacher-grade-delete-button is-danger" onClick={() => void deleteGradeGroup('subject')} disabled={deletingGroup || !visibleGrades.length}>
              <Trash2 size={15} aria-hidden="true" /> {deletingGroup ? 'جارٍ الحذف...' : 'حذف كل علامات المادة'}
            </button>
          </div>}
        </div>
        {visibleGrades.length ? (
          <div className="teacher-table-wrap is-active">
            <table className="teacher-table">
              <thead><tr><th>الطالب</th><th>المكوّن</th><th>العلامة</th><th>السقف</th><th>إجراءات</th></tr></thead>
              <tbody>
                {visibleGrades.map((grade) => (
                  <tr key={`${grade.student_id}-${grade.component}`}>
                    <td>{students.find((student) => student.id === grade.student_id)?.fullName ?? grade.student_id}</td>
                    <td>{componentLabels[grade.component]}</td>
                    <td>{grade.score}</td>
                    <td>{grade.max_score}</td>
                    <td>
                      <div className="teacher-grade-row-actions">
                        <button type="button" className="teacher-grade-edit-button" onClick={() => beginEditGrade(grade)} aria-label={`تعديل ${componentLabels[grade.component]}`}>
                          <Pencil size={15} aria-hidden="true" /> تعديل
                        </button>
                        <button type="button" className="teacher-grade-delete-button" onClick={() => void deleteOneGrade(grade)} disabled={deletingGrade === `${grade.student_id}:${grade.component}`} aria-label={`حذف ${componentLabels[grade.component]}`}>
                          <Trash2 size={15} aria-hidden="true" /> {deletingGrade === `${grade.student_id}:${grade.component}` ? 'جارٍ الحذف...' : 'حذف'}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p className="teacher-grade-hint">لا توجد علامات مدخلة لهذه المادة بعد.</p>}
      </section>
    </div>
  );
}
