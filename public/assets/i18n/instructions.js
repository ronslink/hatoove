import { getLocale, validLocale } from './core.js';

// Curated UI directions only; assessment payloads are never translation lookup keys.
const rows = {
  matching_opinions: ['Ordnen Sie jeder Überschrift die passende Meinung zu.', 'Match each heading to the appropriate opinion.', 'Доберіть до кожного заголовка відповідну думку.', 'اختر الرأي المناسب لكل عنوان.', 'Her başlığı uygun görüşle eşleştirin.'],
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
  'writing.choose_one': ['Lesen Sie beide Aufgaben. Ihre bestätigte Auswahl bleibt für diesen Lauf verbindlich. Anschließend schreiben Sie zu genau dieser Aufgabe.', 'Read both tasks. Your confirmed choice is binding for this run. Then write about that task only.', 'Прочитайте обидва завдання. Підтверджений вибір у цій спробі змінити не можна. Потім виконайте саме це завдання.', 'اقرأ المهمتين. اختيارك المؤكد ملزم لهذه المحاولة. ثم اكتب عن تلك المهمة وحدها.', 'İki görevi de okuyun. Onaylanan seçiminiz bu deneme için bağlayıcıdır. Ardından yalnızca seçtiğiniz görev hakkında yazın.'],
  'mock.timing': ['Die Abschnitte wechseln automatisch. Verlassen, Neuladen und Prüfungswechsel halten die Zeit nicht an. Ein früherer Wechsel der Bearbeitungszeit ist nicht möglich.', 'Sections change automatically. Leaving, reloading or switching exams does not pause time. You cannot move to the next timed section early.', 'Розділи змінюються автоматично. Вихід, перезавантаження або зміна іспиту не зупиняють час. Перейти до наступного розділу раніше неможливо.', 'تتغير الأقسام تلقائيًا. المغادرة أو إعادة التحميل أو تبديل الامتحان لا يوقف الوقت. لا يمكنك الانتقال مبكرًا إلى القسم التالي المحدد بوقت.', 'Bölümler otomatik değişir. Ayrılmak, yeniden yüklemek veya sınav değiştirmek süreyi durdurmaz. Sonraki süreli bölüme erken geçilemez.'],
};
const locales = ['de', 'en', 'uk', 'ar', 'tr'];
const digests = {
  matching_opinions: "082033098d71976a9186cc98819262c056563bab75cc030d09f6ca924cf27e8b",
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
  "writing.choose_one": "18cd1300424f9e3087e576554c066e518a53b001249c0dcd3e3c8325971e8e2d",
  "mock.timing": "8085ded3ee5f1699975ff0c5141bf52b2de9596fb13d9aeb658442c1eeac6b06"
};
const englishDigests = {
  "matching_opinions": "bebe0bc4b27395865af47fb9606565cfed90247100f89f756effffc93fbe9508",
  "public.reading": "2df1049f5793a3a9b2751dc08d73eca752896ac80252bc4cf506e249a401360a",
  "public.grammar": "75d7086e5ce37c07dfd608848106f6611a2258ee15622422c60b41cc71af6dee",
  "public.writing": "a2baa96efcb1023d4427fdf00a783bc11d6a45ca3c926a9f895b5ad245d66a3d",
  "matching_headlines": "03b06f39e961cc7d72fb3558f81829c940b57344231d0d9c4adcf1f0cdc6d2f5",
  "matching_ads": "d7ae27824afcf628d89fb9f5c7e5f1c6a8192484b079657b9d82349aada67cb2",
  "single_choice": "a8fe3f373d26b58702e6d9a1043447c4f60d3e790921ac40abb65608f44fe924",
  "grouped_choice": "096cd7db3e5507fc658f3d4124a88286d6a0cc77df6da788d1b06e93cf66d690",
  "gap_choice": "b8b6fb99caebdb239de3737cfa38ec47e28175f6a026a6cca17a892075a9faf9",
  "gap_bank": "1f3daf5ff4005d03d23a3da5d6764602e4ad3166e05ef0b4f1b1f0858b64f0f2",
  "fixed_audio": "49dc2ad9646491730943b6d98c75cbd7c8dcf54b7a6c776cbbb68c3a5329b032",
  "listening.playback": "26106b513015a4929c8cbb2fc66f600f9086db8e1216392d2e7cd90959748be7",
  "writing.assigned": "8a577f450716a685917d7de640c44d21e6821e512de0ba8953de80e33cc5cbf6",
  "writing.choose_one": "3587d45e06ac20a065e0341d037dd329120f2de397e7e6daee8e1037ed4c21c4",
  "mock.timing": "444ecbaffee19102e27f30266e6abc4a4eb2853bec878acfb229188453203a89"
};
export const INSTRUCTIONS = Object.freeze(Object.fromEntries(Object.entries(rows).flatMap(([baseId, values]) => ['de','en'].map(examLanguage => {
 const id=examLanguage==='de'?baseId:baseId+'.en';
 return [id, Object.freeze({
  id, version: 'ui-v1', examLanguage, original: values[examLanguage==='de'?0:1], sourceSha256: examLanguage==='de'?digests[baseId]:englishDigests[baseId],
  translations: Object.freeze(Object.fromEntries(locales.map((locale, index) => [locale, values[index]]))),
  parameters: Object.freeze(baseId === 'listening.playback' ? { maxPlays: 'positive-integer' } : {}),
})]; }))));
export const instructionFor = (id,language) => {
 const exact=Object.hasOwn(INSTRUCTIONS,id)?INSTRUCTIONS[id]:null;
 return exact?.examLanguage===language ? exact : INSTRUCTIONS[id+'.'+language] || null;
};
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
  const entry = typeof id === 'string' ? instructionFor(id,examLanguage) : null;
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
