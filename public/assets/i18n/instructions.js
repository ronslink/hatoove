import { getLocale, validLocale } from './core.js';

// Curated UI directions only; assessment payloads are never translation lookup keys.
const rows = {
  'public.reading': ['Lesen Sie die Situation. Welcher Kurs erfüllt alle Anforderungen?', 'Read the situation. Which course meets all the requirements?', 'Прочитайте ситуацію. Який курс відповідає всім вимогам?', 'اقرأ الموقف. أي دورة تستوفي جميع المتطلبات؟', 'Durumu okuyun. Hangi kurs tüm koşulları karşılıyor?'],
  'public.grammar': ['Wählen Sie das Wort, das den Satz vervollständigt.', 'Choose the word that completes the sentence.', 'Виберіть слово, яке доповнює речення.', 'اختر الكلمة التي تكمل الجملة.', 'Cümleyi tamamlayan sözcüğü seçin.'],
  'public.writing': ['Lesen Sie Milas Nachricht. Schreiben Sie eine Antwort und gehen Sie auf alle vier Punkte ein.', 'Read Mila’s message. Write a reply and address all four points.', 'Прочитайте повідомлення Міли. Напишіть відповідь і розкрийте всі чотири пункти.', 'اقرأ رسالة ميلا. اكتب ردًا وتناول النقاط الأربع كلها.', 'Mila’nın mesajını okuyun. Dört noktanın tamamına değinen bir yanıt yazın.'],
  matching_headlines: ['Ordnen Sie jedem Text die passende Überschrift zu.', 'Match each text to the appropriate heading.', 'Доберіть до кожного тексту відповідний заголовок.', 'اختر العنوان المناسب لكل نص.', 'Her metni uygun başlıkla eşleştirin.'],
  matching_ads: ['Ordnen Sie jeder Situation die passende Anzeige zu. Wenn keine Anzeige passt, wählen Sie x.', 'Match each situation to an advertisement. If none fits, choose x.', 'Доберіть до кожної ситуації оголошення. Якщо жодне не підходить, виберіть x.', 'اختر الإعلان المناسب لكل موقف. إذا لم يناسب أي إعلان، فاختر x.', 'Her durumu uygun ilanla eşleştirin. Hiçbiri uygun değilse x seçin.'],
  single_choice: ['Lesen Sie den Text und wählen Sie für jede Aufgabe eine Antwort.', 'Read the text and choose one answer for each question.', 'Прочитайте текст і виберіть одну відповідь для кожного завдання.', 'اقرأ النص واختر إجابة واحدة لكل سؤال.', 'Metni okuyun ve her soru için bir yanıt seçin.'],
  grouped_choice: ['Lesen Sie den zugehörigen Text und wählen Sie für jede Aufgabe eine Antwort.', 'Read the associated text and choose one answer for each question.', 'Прочитайте відповідний текст і виберіть одну відповідь для кожного завдання.', 'اقرأ النص المرتبط واختر إجابة واحدة لكل سؤال.', 'İlgili metni okuyun ve her soru için bir yanıt seçin.'],
  gap_choice: ['Wählen Sie für jede Lücke eine der angebotenen Antworten.', 'Choose one of the offered answers for each gap.', 'Для кожного пропуску виберіть одну із запропонованих відповідей.', 'اختر إجابة من الخيارات المتاحة لكل فراغ.', 'Her boşluk için sunulan yanıtlardan birini seçin.'],
  gap_bank: ['Wählen Sie für jede Lücke ein Wort aus der Wortliste.', 'Choose a word from the word bank for each gap.', 'Для кожного пропуску виберіть слово зі списку.', 'اختر كلمة من قائمة الكلمات لكل فراغ.', 'Her boşluk için sözcük listesinden bir sözcük seçin.'],
  fixed_audio: ['Hören Sie die Aufnahme und wählen Sie für jede Aufgabe eine Antwort.', 'Listen to the recording and choose one answer for each question.', 'Прослухайте запис і виберіть одну відповідь для кожного завдання.', 'استمع إلى التسجيل واختر إجابة واحدة لكل سؤال.', 'Kaydı dinleyin ve her soru için bir yanıt seçin.'],
  'listening.playback': ['Sie dürfen jede Aufnahme in diesem Lauf {maxPlays}-mal hören. Zurückspulen und Tempoänderungen sind nicht vorgesehen.', 'You may listen to each recording {maxPlays} time(s) in this run. Rewinding and speed changes are not available.', 'У цій спробі кожен запис можна прослухати {maxPlays} раз(и). Перемотування назад і зміна швидкості недоступні.', 'يمكنك الاستماع إلى كل تسجيل {maxPlays} مرة في هذه المحاولة. لا تتوفر إعادة الترجيع أو تغييرات السرعة.', 'Bu denemede her kaydı {maxPlays} kez dinleyebilirsiniz. Geri sarma ve hız değiştirme kullanılamaz.'],
  'writing.assigned': ['Lesen Sie die Aufgabe. Schreiben Sie zu allen genannten Punkten.', 'Read the task. Write about all the listed points.', 'Прочитайте завдання. Напишіть про всі зазначені пункти.', 'اقرأ المهمة. اكتب عن جميع النقاط المذكورة.', 'Görevi okuyun. Belirtilen tüm noktalara değinin.'],
  'writing.choose_one': ['Lies beide Aufgaben. Deine bestätigte Auswahl bleibt für diesen Lauf verbindlich. Anschließend schreibst du zu genau dieser Aufgabe.', 'Read both tasks. Your confirmed choice is binding for this run. Then write about that task only.', 'Прочитайте обидва завдання. Підтверджений вибір у цій спробі змінити не можна. Потім виконайте саме це завдання.', 'اقرأ المهمتين. اختيارك المؤكد ملزم لهذه المحاولة. ثم اكتب عن تلك المهمة وحدها.', 'İki görevi de okuyun. Onaylanan seçiminiz bu deneme için bağlayıcıdır. Ardından yalnızca seçtiğiniz görev hakkında yazın.'],
  'mock.timing': ['Die Abschnitte wechseln automatisch. Verlassen, Neuladen und Prüfungswechsel halten die Zeit nicht an. Ein früherer Wechsel der Bearbeitungszeit ist nicht möglich.', 'Sections change automatically. Leaving, reloading or switching exams does not pause time. You cannot move to the next timed section early.', 'Розділи змінюються автоматично. Вихід, перезавантаження або зміна іспиту не зупиняють час. Перейти до наступного розділу раніше неможливо.', 'تتغير الأقسام تلقائيًا. المغادرة أو إعادة التحميل أو تبديل الامتحان لا يوقف الوقت. لا يمكنك الانتقال مبكرًا إلى القسم التالي المحدد بوقت.', 'Bölümler otomatik değişir. Ayrılmak, yeniden yüklemek veya sınav değiştirmek süreyi durdurmaz. Sonraki süreli bölüme erken geçilemez.'],
};
const locales = ['de', 'en', 'uk', 'ar', 'tr'];
const digests = {
  "public.reading": "d7263cf9f4eb62437284399c541164212ac530fb345f97b01ca18992f6c57075",
  "public.grammar": "da1301fb196cfa90808afe4a7cf9efd89e09eab78db330f0969f4833ef0956e0",
  "public.writing": "e8535bbeac7bb41858f49a965cca810cab54b8fd6431b49a567ae92ebad4055f",
  "matching_headlines": "30eb20099cf00f1e5256e56f394e81556565661040a9aeb0ce915d1f44a0ba53",
  "matching_ads": "8ccd6dea2a28e6fa1b6eccb1caec4317656329ea4bceb5f28b5a086797dd6f6d",
  "single_choice": "ce4b25eeee76209aada527284fbcdca451dd839b13a8b2a4ec500977e0e237a3",
  "grouped_choice": "2f958a411a2ff932c517fe7ff20d04382b1fcf7095e4e318443e85639a861353",
  "gap_choice": "3ef965a324e6e3571bf83738d34f052511623e762be610c891682a9ab4c84457",
  "gap_bank": "4d03ef464c886b83f16b2b555d8900182cb9cd340ac3100ff40232de272b5e49",
  "fixed_audio": "78cffd19976d8a99bfd9a2378bfbe7551724c3266a6c53e87aa5bbc5dab61aa6",
  "listening.playback": "fef8aa70df1a0111b36ceb7c8d80ce07601aafa43710a00f44630bf88d13cdbe",
  "writing.assigned": "26026859d955e91523e8e5b218b8ef2b0d59267eed613a8e3c9eb688d615ca84",
  "writing.choose_one": "bd6deabfd2a6094625a14932587da247f5865712d5c616c85cb16f644fba261b",
  "mock.timing": "8085ded3ee5f1699975ff0c5141bf52b2de9596fb13d9aeb658442c1eeac6b06"
};
export const INSTRUCTIONS = Object.freeze(Object.fromEntries(Object.entries(rows).map(([id, values]) => [id, Object.freeze({
  id, version: 'ui-v1', examLanguage: 'de', original: values[0], sourceSha256: digests[id],
  translations: Object.freeze(Object.fromEntries(locales.map((locale, index) => [locale, values[index]]))),
  parameters: Object.freeze(id === 'listening.playback' ? { maxPlays: 'positive-integer' } : {}),
})])));
const unavailable = {
  de: 'Die Übersetzung dieser Anleitung ist nicht verfügbar. Die Originalanleitung bleibt sichtbar.',
  en: 'A translation of these directions is unavailable. The original directions remain visible.',
  uk: 'Переклад цієї інструкції недоступний. Оригінальна інструкція залишається видимою.',
  ar: 'ترجمة هذه التعليمات غير متاحة. تبقى التعليمات الأصلية ظاهرة.',
  tr: 'Bu yönergelerin çevirisi kullanılamıyor. Özgün yönergeler görünür kalır.',
};
const originalUnavailable = Object.freeze({
  de:'Diese Anleitung ist in der Prüfungssprache nicht verfügbar. Eine Übersetzung kann nicht angezeigt werden.',
  en:'These directions are unavailable in the exam language. A translation cannot be displayed.',
  uk:'Ця інструкція недоступна мовою іспиту. Переклад неможливо показати.',
  ar:'هذه التعليمات غير متاحة بلغة الامتحان. لا يمكن عرض ترجمة.',
  tr:'Bu yönergeler sınav dilinde mevcut değil. Çeviri gösterilemiyor.',
});
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const format = (template, parameters) => template.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (_, key) => String(parameters[key]));
export function instructionView({ id, examLanguage, original, parameters = {}, locale = getLocale() }) {
  const selected = validLocale(locale) ? locale : 'de';
  const entry = typeof id === 'string' && Object.hasOwn(INSTRUCTIONS, id) ? INSTRUCTIONS[id] : null;
  const record = parameters && typeof parameters === 'object' && !Array.isArray(parameters)
    && [Object.prototype, null].includes(Object.getPrototypeOf(parameters));
  const names = record ? Reflect.ownKeys(parameters) : [];
  const types = entry && names.length === Object.keys(entry.parameters).length && names.every(name => Object.hasOwn(entry.parameters, name)
    && Object.hasOwn(Object.getOwnPropertyDescriptor(parameters, name), 'value')
    && Number.isSafeInteger(parameters[name]) && parameters[name] > 0 && parameters[name] <= 100);
  const known = Boolean(validLocale(locale) && entry && record && types && examLanguage === entry.examLanguage && original === entry.original && entry.translations[selected]);
  return { known, id: entry?.id || '', version: entry?.version || '', digest: known ? entry.sourceSha256 : '',
    original: known ? format(entry.original, parameters) : typeof original === 'string' ? original : '',
    examLanguage: typeof examLanguage === 'string' && /^[a-z]{2,3}(?:-[A-Za-z0-9]+)*$/.test(examLanguage) ? examLanguage : 'und',
    locale: selected, translation: known ? selected === examLanguage ? '' : format(entry.translations[selected], parameters) : typeof original === 'string' && original ? unavailable[selected] : originalUnavailable[selected] };
}
export function instructionMarkup(options) {
  const view = instructionView(options);
  const parameters = view.known ? Object.fromEntries(Object.keys(INSTRUCTIONS[view.id].parameters).map(key => [key, options.parameters[key]])) : {};
  const metadata = { id: view.known ? view.id : '', examLanguage: view.examLanguage, original: typeof options.original === 'string' ? options.original : '', parameters };
  return `<div class="bilingual-instruction" data-instruction="${escape(JSON.stringify(metadata))}" data-instruction-version="${escape(view.version)}" data-instruction-digest="${escape(view.digest)}"><p data-instruction-original lang="${escape(view.examLanguage)}" dir="${view.examLanguage === 'ar' ? 'rtl' : 'ltr'}">${escape(view.original)}</p><p data-instruction-translation lang="${view.locale}" dir="${view.locale === 'ar' ? 'rtl' : 'ltr'}"${view.translation ? '' : ' hidden'}>${escape(view.translation)}</p></div>`;
}
export function translateInstructions(root, locale = getLocale()) {
  for (const node of root?.querySelectorAll?.('[data-instruction]') || []) {
    if (!node.isConnected) continue;
    let options; try { options = JSON.parse(node.dataset.instruction); } catch { continue; }
    const view = instructionView({ ...options, locale }), translated = node.querySelector('[data-instruction-translation]');
    if (!translated) continue;
    translated.textContent = view.translation; translated.lang = view.locale; translated.dir = view.locale === 'ar' ? 'rtl' : 'ltr'; translated.hidden = !view.translation;
  }
}
