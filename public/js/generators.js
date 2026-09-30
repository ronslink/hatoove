/**
 * Offline item generator.
 *
 * This is what makes the trainer dynamic even with no API key: every tag below has
 * a hand-written pool of authentic B1 items, and the generator shuffles options and
 * picks the item that best matches the difficulty the engine is currently aiming at.
 *
 * The tag list deliberately mirrors the grammar that actually recurs in telc B1
 * Sprachbausteine Teil 1: case after prepositions, relative pronouns, the Perfekt
 * auxiliary, adjective endings, connectors and connecting adverbs, pronouns.
 */

const POOLS = {
  /* ------------------------------------------------------------ Grammatik */

  konnektoren: [
    { q: 'Ich kann heute leider nicht kommen, ___ ich habe noch einen Termin.', options: ['denn', 'weil', 'deshalb'], answer: 'denn', why: 'Nach "denn" bleibt die normale Wortstellung (Subjekt + Verb). Nach "weil" müsste das Verb ans Ende: "… weil ich noch einen Termin habe".' },
    { q: 'Es hat den ganzen Tag geregnet, ___ sind wir zu Hause geblieben.', options: ['deshalb', 'trotzdem', 'denn'], answer: 'deshalb', why: '"deshalb" drückt die Folge aus: Regen → zu Hause bleiben.' },
    { q: 'Sie ist sehr müde, ___ geht sie noch joggen.', options: ['trotzdem', 'deshalb', 'damit'], answer: 'trotzdem', why: '"trotzdem" = Gegensatz/Einräumung: müde, aber trotzdem joggen.' },
    { q: 'Ich möchte keinen Tee, ___ Kaffee.', options: ['sondern', 'aber', 'oder'], answer: 'sondern', why: 'Nach einer Verneinung korrigiert man mit "sondern": nicht Tee, sondern Kaffee.' },
    { q: 'Er lernt Deutsch, ___ er in Berlin arbeiten will.', options: ['weil', 'denn', 'deshalb'], answer: 'weil', why: 'Nach "weil" steht das Verb am Ende: "… weil er in Berlin arbeiten will". Das passt hier.' },
    { q: '___ ich früh ins Bett gegangen bin, bin ich noch müde.', options: ['Obwohl', 'Weil', 'Damit'], answer: 'Obwohl', why: '"Obwohl" leitet einen Gegensatz ein: früh schlafen, trotzdem müde.' },
    { q: 'Ich rufe dich an, ___ ich am Bahnhof bin.', options: ['wenn', 'als', 'damit'], answer: 'wenn', why: '"wenn" für jedes Ereignis in der Gegenwart/Zukunft; "als" nur für ein einmaliges Ereignis in der Vergangenheit.' },
    { q: 'Sie spricht langsam, ___ die Kinder sie besser verstehen.', options: ['damit', 'um', 'dass'], answer: 'damit', why: '"damit" + Nebensatz mit Verb am Ende drückt einen Zweck aus.' },
    { q: 'Das Zimmer war sehr klein. ___ war es ziemlich teuer.', options: ['Trotzdem', 'Deshalb', 'Außerdem'], answer: 'Trotzdem', why: '"Trotzdem" steht am Satzanfang, dann folgt das Verb: "Trotzdem war es …".' },
    { q: 'Ich habe kein Auto, ___ fahre ich mit dem Fahrrad zur Arbeit.', options: ['deshalb', 'obwohl', 'sondern'], answer: 'deshalb', why: 'Grund → Folge: kein Auto, deshalb Fahrrad.' },
    { q: '___ sie viel gearbeitet hat, hat sie die Prüfung nicht bestanden.', options: ['Obwohl', 'Weil', 'Wenn'], answer: 'Obwohl', why: 'Gegensatz: viel Arbeit, aber nicht bestanden → "obwohl".' },
    { q: 'Er kam zu spät, ___ er den Bus verpasst hatte.', options: ['weil', 'denn', 'deshalb'], answer: 'weil', why: '"weil" + Plusquamperfekt am Ende: "… weil er den Bus verpasst hatte".' },
    // The connectors below are the ones the exam reuses most, each drilling the
    // word-order trap rather than just the meaning.
    { q: 'Ich habe kein Geld, ___ kann ich nicht mitfahren.', options: ['deshalb', 'weil', 'obwohl'], answer: 'deshalb', why: '"deshalb" ist ein Adverb: Position 1, das Verb folgt direkt. Nach "weil" müsste das Verb ans Ende.' },
    { q: 'Er war sehr müde, ___ hat er weitergearbeitet.', options: ['trotzdem', 'deshalb', 'damit'], answer: 'trotzdem', why: '"trotzdem" = Gegensatz: müde, aber trotzdem weitergearbeitet.' },
    { q: 'Die Wohnung ist teuer. ___ liegt sie weit von der Arbeit.', options: ['Außerdem', 'Trotzdem', 'Damit'], answer: 'Außerdem', why: '"außerdem" fügt einen weiteren Nachteil hinzu – es drückt keinen Gegensatz aus.' },
    { q: 'Zuerst suchen wir ein Hotel, ___ buchen wir die Tickets.', options: ['danach', 'davor', 'damit'], answer: 'danach', why: '"danach" = zeitliche Reihenfolge: erst das eine, dann das andere.' },
    { q: '___ ich in Deutschland lebe, habe ich viel gelernt.', options: ['Seitdem', 'Damit', 'Trotzdem'], answer: 'Seitdem', why: '"seitdem" + Verb am Ende: Zeitraum, der in der Vergangenheit begann und andauert.' },
    { q: '___ es morgen regnet, bleiben wir zu Hause.', options: ['Falls', 'Damit', 'Deshalb'], answer: 'Falls', why: '"falls" = wenn eventuell; drückt eine Bedingung aus (Verb am Ende).' },
    { q: '___ ich angekommen war, rief ich meine Mutter an.', options: ['Nachdem', 'Bevor', 'Während'], answer: 'Nachdem', why: '"nachdem" für die Vorzeitigkeit; danach steht meist Plusquamperfekt.' },
    { q: '___ ich frühstücke, lese ich die Zeitung.', options: ['Während', 'Nachdem', 'Seitdem'], answer: 'Während', why: '"während" = gleichzeitig: beide Handlungen laufen parallel.' },
    { q: '___ du gehst, mach bitte das Licht aus.', options: ['Bevor', 'Nachdem', 'Während'], answer: 'Bevor', why: '"bevor" = vorher; die Handlung im Nebensatz kommt später.' },
    { q: 'Sie spricht sehr leise, ___ ich sie kaum verstehen kann.', options: ['so dass', 'damit', 'obwohl'], answer: 'so dass', why: '"so dass" drückt die Folge aus; "damit" drückt einen Zweck aus.' },
    { q: 'Man lernt eine Sprache am besten, ___ man sie täglich benutzt.', options: ['indem', 'damit', 'so dass'], answer: 'indem', why: '"indem" nennt das Mittel: auf welche Weise erreicht man etwas?' },
    { q: '___ mehr du lernst, desto besser wird dein Deutsch.', options: ['Je', 'Wenn', 'Damit'], answer: 'Je', why: 'Feste Struktur "je … desto": Je mehr du lernst, desto besser …' },
    { q: 'Beeil dich, ___ kommen wir zu spät.', options: ['sonst', 'damit', 'deshalb'], answer: 'sonst', why: '"sonst" = andernfalls; warnt vor der negativen Folge.' },
    { q: 'Das Hotel war teuer, ___ war es sehr schön.', options: ['allerdings', 'deshalb', 'damit'], answer: 'allerdings', why: '"allerdings" räumt einen Gegensatz ein: teuer, aber trotzdem schön.' },
    { q: 'Er spricht sowohl Deutsch ___ auch Englisch.', options: ['als', 'wie', 'oder'], answer: 'als', why: 'Feste Struktur "sowohl … als auch" – nicht "wie".' },
    { q: 'Ich weiß nicht, ___ er morgen kommt.', options: ['ob', 'wenn', 'dass'], answer: 'ob', why: '"ob" leitet eine indirekte Ja/Nein-Frage ein; "wenn" drückt eine Bedingung aus.' },
  ],

  praeposition_kasus: [
    { q: 'Ich wohne noch bei ___ Eltern.', options: ['meinen', 'meine', 'meiner'], answer: 'meinen', why: '"bei" verlangt den Dativ. Plural Dativ: meinen Eltern.' },
    { q: 'Nach ___ Arbeit gehe ich oft schwimmen.', options: ['der', 'die', 'den'], answer: 'der', why: '"nach" + Dativ, "die Arbeit" → "der Arbeit".' },
    { q: 'Ich fahre jeden Tag mit ___ Fahrrad zur Arbeit.', options: ['dem', 'das', 'den'], answer: 'dem', why: '"mit" + Dativ, "das Fahrrad" → "dem Fahrrad".' },
    { q: 'Das Geschenk ist für ___ Bruder.', options: ['meinen', 'meinem', 'mein'], answer: 'meinen', why: '"für" + Akkusativ, maskulin → "meinen Bruder".' },
    { q: 'Wir gehen ohne ___ ins Kino.', options: ['dich', 'dir', 'du'], answer: 'dich', why: '"ohne" + Akkusativ → "ohne dich".' },
    { q: 'Seit ___ Jahr wohne ich in Wien.', options: ['einem', 'einen', 'ein'], answer: 'einem', why: '"seit" + Dativ, neutrum → "einem Jahr".' },
    { q: 'Ich komme gerade aus ___ Stadt.', options: ['der', 'die', 'den'], answer: 'der', why: '"aus" + Dativ, "die Stadt" → "der Stadt".' },
    { q: 'Wir fahren morgen zu ___ Arzt.', options: ['dem', 'den', 'der'], answer: 'dem', why: '"zu" + Dativ, "der Arzt" → "dem Arzt".' },
    { q: 'Er hat etwas gegen ___ Plan.', options: ['diesen', 'diesem', 'dieser'], answer: 'diesen', why: '"gegen" + Akkusativ, maskulin → "diesen Plan".' },
    { q: 'Ich habe das Buch für ___ Schwester gekauft.', options: ['meine', 'meiner', 'meinen'], answer: 'meine', why: '"für" + Akkusativ, feminin → "meine Schwester".' },
    { q: 'Nach ___ Unterricht gehe ich direkt nach Hause.', options: ['dem', 'den', 'der'], answer: 'dem', why: '"nach" + Dativ, "der Unterricht" → "dem Unterricht".' },
    { q: 'Sie kommt mit ___ Schwester zur Party.', options: ['ihrer', 'ihre', 'ihren'], answer: 'ihrer', why: '"mit" + Dativ, feminin → "ihrer Schwester".' },
  ],

  wechselpraeposition: [
    { q: 'Ich hänge das Bild an ___ Wand.', options: ['die', 'der', 'dem'], answer: 'die', why: 'Wohin? → Akkusativ. "an die Wand" (Bewegung/Richtung).' },
    { q: 'Das Bild hängt schon an ___ Wand.', options: ['der', 'die', 'den'], answer: 'der', why: 'Wo? → Dativ. "an der Wand" (Position).' },
    { q: 'Ich lege das Buch auf ___ Tisch.', options: ['den', 'dem', 'der'], answer: 'den', why: 'Wohin? → Akkusativ: "auf den Tisch".' },
    { q: 'Das Buch liegt auf ___ Tisch.', options: ['dem', 'den', 'das'], answer: 'dem', why: 'Wo? → Dativ: "auf dem Tisch".' },
    { q: 'Wir gehen heute in ___ Kino.', options: ['das', 'dem', 'der'], answer: 'das', why: 'Wohin? → Akkusativ: "in das Kino".' },
    { q: 'Wir sind gestern in ___ Kino gewesen.', options: ['dem', 'das', 'den'], answer: 'dem', why: 'Wo? → Dativ: "in dem Kino".' },
    { q: 'Sie stellt die Flasche in ___ Kühlschrank.', options: ['den', 'dem', 'der'], answer: 'den', why: 'Wohin? → Akkusativ, maskulin: "in den Kühlschrank".' },
    { q: 'Die Flasche steht in ___ Kühlschrank.', options: ['dem', 'den', 'das'], answer: 'dem', why: 'Wo? → Dativ, maskulin: "in dem Kühlschrank".' },
    { q: 'Ich setze mich auf ___ Stuhl.', options: ['den', 'dem', 'der'], answer: 'den', why: 'Wohin? → Akkusativ: "auf den Stuhl".' },
    { q: 'Ich sitze schon auf ___ Stuhl.', options: ['dem', 'den', 'das'], answer: 'dem', why: 'Wo? → Dativ: "auf dem Stuhl".' },
    { q: 'Er hängt die Jacke in ___ Schrank.', options: ['den', 'dem', 'der'], answer: 'den', why: 'Wohin? → Akkusativ: "in den Schrank".' },
    { q: 'Die Jacke hängt in ___ Schrank.', options: ['dem', 'den', 'das'], answer: 'dem', why: 'Wo? → Dativ: "in dem Schrank".' },
  ],

  perfekt_auxiliar: [
    { q: 'Gestern ___ ich mit dem Bus nach Hause gefahren.', options: ['bin', 'habe', 'wurde'], answer: 'bin', why: '"fahren" ist ein Bewegungsverb → Perfekt mit "sein": ich bin gefahren.' },
    { q: 'Wir ___ gestern einen guten Film gesehen.', options: ['haben', 'sind', 'waren'], answer: 'haben', why: '"sehen" bildet das Perfekt mit "haben".' },
    { q: 'Er ___ um 22 Uhr nach Hause gegangen.', options: ['ist', 'hat', 'wurde'], answer: 'ist', why: '"gehen" ist ein Bewegungsverb → "ist gegangen".' },
    { q: 'Der Zug ___ pünktlich in Köln angekommen.', options: ['ist', 'hat', 'war'], answer: 'ist', why: '"ankommen" beschreibt einen Ortswechsel → Perfekt mit "sein".' },
    { q: 'Ich ___ drei Jahre in Hamburg gewohnt.', options: ['habe', 'bin', 'war'], answer: 'habe', why: '"wohnen" ist kein Bewegungsverb → "habe gewohnt".' },
    { q: 'Das Kind ___ endlich eingeschlafen.', options: ['ist', 'hat', 'wurde'], answer: 'ist', why: '"einschlafen" ist ein Zustandswechsel → Perfekt mit "sein".' },
    { q: 'Wir ___ uns lange über die Prüfung unterhalten.', options: ['haben', 'sind', 'waren'], answer: 'haben', why: '"sich unterhalten" → Perfekt mit "haben".' },
    { q: 'Meine Schwester ___ gestern Geburtstag gehabt.', options: ['hat', 'ist', 'war'], answer: 'hat', why: '"haben" bildet das Perfekt mit sich selbst: "hat gehabt".' },
    { q: 'Ich ___ meine Hausaufgaben schon gemacht.', options: ['habe', 'bin', 'werde'], answer: 'habe', why: '"machen" → Perfekt mit "haben".' },
    { q: 'Die Familie ___ letztes Jahr nach Kanada gezogen.', options: ['ist', 'hat', 'wurde'], answer: 'ist', why: '"ziehen" (umziehen) = Ortswechsel → "ist gezogen".' },
    { q: 'Wir ___ gestern lange auf dich gewartet.', options: ['haben', 'sind', 'waren'], answer: 'haben', why: '"warten" → Perfekt mit "haben".' },
    { q: 'Sie ___ schnell eingeschlafen.', options: ['ist', 'hat', 'war'], answer: 'ist', why: 'Zustandswechsel (wach → schlafend) → "ist eingeschlafen".' },
  ],

  partizip2: [
    { q: 'Ich habe gestern meine Tante ___ (besuchen).', options: ['besucht', 'gebesucht', 'besuchen'], answer: 'besucht', why: 'Untrennbare Verben mit be-/ver-/er- bilden das Partizip II ohne "ge-": besucht.' },
    { q: 'Hast du die E-Mail schon ___ (schreiben)?', options: ['geschrieben', 'geschreibt', 'schreiben'], answer: 'geschrieben', why: 'Starkes Verb: schreiben → geschrieben.' },
    { q: 'Er hat die Rechnung noch nicht ___ (bezahlen).', options: ['bezahlt', 'gebezahlt', 'bezahlen'], answer: 'bezahlt', why: '"bezahlen" ist untrennbar → Partizip II ohne "ge-".' },
    { q: 'Wir haben den ganzen Tag ___ (arbeiten).', options: ['gearbeitet', 'gearbeit', 'arbeitet'], answer: 'gearbeitet', why: 'Verben auf -en/-eln/-ern: gearbeitet.' },
    { q: 'Sie hat ihre Mutter dreimal ___ (anrufen).', options: ['angerufen', 'gerufen an', 'angeruft'], answer: 'angerufen', why: 'Trennbares Verb: an- + gerufen = angerufen.' },
    { q: 'Ich habe das Buch in zwei Tagen ___ (lesen).', options: ['gelesen', 'gelesen gehabt', 'gelesen worden'], answer: 'gelesen', why: 'Starkes Verb: lesen → gelesen.' },
    { q: 'Hast du heute schon ___ (frühstücken)?', options: ['gefrühstückt', 'gefrühstücken', 'frühstückt'], answer: 'gefrühstückt', why: 'Schwaches Verb auf -en → -t: gefrühstückt.' },
    { q: 'Ich habe dir die Wahrheit ___ (sagen).', options: ['gesagt', 'gesagen', 'sagt'], answer: 'gesagt', why: 'Schwaches Verb: sagen → gesagt.' },
    { q: 'Wir haben das Fest gut ___ (vorbereiten).', options: ['vorbereitet', 'bereitet vor', 'vorbereiten'], answer: 'vorbereitet', why: '"vorbereiten" ist untrennbar → vorbereitet.' },
    { q: 'Ich habe leider nichts ___ (verstehen).', options: ['verstanden', 'geverstanden', 'verstehe'], answer: 'verstanden', why: 'Starkes, untrennbares Verb: verstehen → verstanden.' },
    { q: 'Sie hat sich die Haare ___ (waschen).', options: ['gewaschen', 'gewaschen gehabt', 'wascht'], answer: 'gewaschen', why: 'Starkes Verb: waschen → gewaschen.' },
    { q: 'Er ist gestern spät ___ (aufstehen).', options: ['aufgestanden', 'gestanden auf', 'aufstehen'], answer: 'aufgestanden', why: 'Trennbares Verb: auf- + gestanden = aufgestanden.' },
  ],

  adjektivendungen: [
    { q: 'Ich habe mir ein neu___ Auto gekauft.', options: ['neues', 'neue', 'neuen'], answer: 'neues', why: 'Neutrum mit unbestimmtem Artikel im Akkusativ → -es: ein neues Auto.' },
    { q: 'Der klein___ Junge spielt im Garten.', options: ['kleine', 'kleiner', 'kleines'], answer: 'kleine', why: 'Maskulinum mit bestimmtem Artikel im Nominativ → -e: der kleine Junge.' },
    { q: 'Wir wohnen in einer sehr groß___ Wohnung.', options: ['großen', 'große', 'großer'], answer: 'großen', why: 'Femininum mit unbestimmtem Artikel im Dativ → -en: in einer großen Wohnung.' },
    { q: 'Das ist mein best___ Freund.', options: ['bester', 'beste', 'besten'], answer: 'bester', why: 'Maskulinum Nominativ nach Possessivartikel → -er: mein bester Freund.' },
    { q: 'Bei schlecht___ Wetter bleiben wir zu Hause.', options: ['schlechtem', 'schlechten', 'schlechter'], answer: 'schlechtem', why: '"bei" + Dativ, Neutrum → -em: bei schlechtem Wetter.' },
    { q: 'Die neu___ Nachbarn sind sehr freundlich.', options: ['neuen', 'neue', 'neuer'], answer: 'neuen', why: 'Plural mit bestimmtem Artikel → -en: die neuen Nachbarn.' },
    { q: 'Mit dem alt___ Fahrrad fahre ich zur Arbeit.', options: ['alten', 'alte', 'alter'], answer: 'alten', why: 'Dativ, Neutrum, bestimmter Artikel → -en: mit dem alten Fahrrad.' },
    { q: 'Sie hat einen interessant___ Beruf.', options: ['interessanten', 'interessante', 'interessanter'], answer: 'interessanten', why: 'Maskulinum Akkusativ mit unbestimmtem Artikel → -en: einen interessanten Beruf.' },
    { q: 'Das ist eine wichtig___ Frage.', options: ['wichtige', 'wichtigen', 'wichtiger'], answer: 'wichtige', why: 'Femininum Nominativ mit unbestimmtem Artikel → -e: eine wichtige Frage.' },
    { q: 'Ich trinke gern kalt___ Wasser.', options: ['kaltes', 'kalte', 'kalten'], answer: 'kaltes', why: 'Ohne Artikel, Neutrum Akkusativ → -es: kaltes Wasser.' },
    { q: 'Wir haben leider kein___ Zeit mehr.', options: ['keine', 'keinen', 'keiner'], answer: 'keine', why: '"die Zeit" ist feminin → keine Zeit.' },
    { q: 'Er wohnt in einem klein___ Dorf.', options: ['kleinen', 'kleine', 'kleinem'], answer: 'kleinen', why: 'Dativ Neutrum mit unbestimmtem Artikel → -en: in einem kleinen Dorf.' },
  ],

  relativpronomen: [
    { q: 'Das ist der Mann, ___ ich gestern getroffen habe.', options: ['den', 'dem', 'der'], answer: 'den', why: 'Relativpronomen im Akkusativ, maskulin (ich habe ihn getroffen) → den.' },
    { q: 'Die Frau, ___ dort steht, ist meine Chefin.', options: ['die', 'der', 'denen'], answer: 'die', why: 'Femininum Nominativ → die.' },
    { q: 'Das Haus, in ___ wir wohnen, ist sehr alt.', options: ['dem', 'das', 'den'], answer: 'dem', why: '"in" + Dativ, Neutrum → in dem.' },
    { q: 'Die Kollegen, mit ___ ich arbeite, sind sehr nett.', options: ['denen', 'den', 'die'], answer: 'denen', why: '"mit" + Dativ Plural → mit denen.' },
    { q: 'Der Film, ___ wir gesehen haben, war langweilig.', options: ['den', 'der', 'dem'], answer: 'den', why: 'Akkusativ maskulin → den (wir haben ihn gesehen).' },
    { q: 'Die Stadt, in ___ ich geboren bin, heißt Bonn.', options: ['der', 'die', 'dem'], answer: 'der', why: '"in" + Dativ, feminin → in der.' },
    { q: 'Der Kollege, ___ ich das Buch gegeben habe, ist krank.', options: ['dem', 'den', 'der'], answer: 'dem', why: 'Dativ maskulin (ich habe ihm das Buch gegeben) → dem.' },
    { q: 'Das ist die Firma, bei ___ ich arbeite.', options: ['der', 'die', 'dem'], answer: 'der', why: '"bei" + Dativ, feminin → bei der.' },
    { q: 'Die Freunde, ___ ich eingeladen habe, kommen später.', options: ['die', 'denen', 'den'], answer: 'die', why: 'Akkusativ Plural → die.' },
    { q: 'Das Kind, ___ Eltern in Spanien leben, wohnt bei uns.', options: ['dessen', 'deren', 'dem'], answer: 'dessen', why: 'Genitiv maskulin/neutrum → dessen.' },
    { q: 'Kennst du den Autor, ___ Buch so berühmt ist?', options: ['dessen', 'dem', 'den'], answer: 'dessen', why: 'Genitiv: das Buch des Autors → dessen Buch.' },
    { q: 'Die Aufgabe, ___ wir lösen mussten, war schwer.', options: ['die', 'der', 'denen'], answer: 'die', why: 'Akkusativ feminin → die.' },
  ],

  possessivartikel: [
    { q: 'Ich fahre mit mein___ Bruder nach München.', options: ['meinem', 'meinen', 'meiner'], answer: 'meinem', why: '"mit" + Dativ, maskulin → meinem Bruder.' },
    { q: 'Sie liebt ihr___ Hund über alles.', options: ['ihren', 'ihrem', 'ihre'], answer: 'ihren', why: 'Akkusativ maskulin → ihren Hund.' },
    { q: 'Wir besuchen am Sonntag unser___ Großeltern.', options: ['unsere', 'unseren', 'unserer'], answer: 'unsere', why: 'Akkusativ Plural → unsere Großeltern.' },
    { q: 'Hast du dein___ Schlüssel dabei?', options: ['deinen', 'deinem', 'deine'], answer: 'deinen', why: 'Akkusativ maskulin → deinen Schlüssel.' },
    { q: 'Er wohnt noch bei sein___ Eltern.', options: ['seinen', 'seine', 'seiner'], answer: 'seinen', why: '"bei" + Dativ Plural → seinen Eltern.' },
    { q: 'Ich habe mein___ Tasche im Bus vergessen.', options: ['meine', 'meinen', 'meiner'], answer: 'meine', why: 'Akkusativ feminin → meine Tasche.' },
    { q: 'Ist das wirklich dein___ Jacke?', options: ['deine', 'deinen', 'deiner'], answer: 'deine', why: 'Femininum Nominativ → deine Jacke.' },
    { q: 'Sie hat ihr___ Bruder gestern angerufen.', options: ['ihren', 'ihrem', 'ihre'], answer: 'ihren', why: 'Akkusativ maskulin → ihren Bruder.' },
    { q: 'Nach unser___ Reise waren wir sehr müde.', options: ['unserer', 'unseren', 'unsere'], answer: 'unserer', why: '"nach" + Dativ, feminin → unserer Reise.' },
    { q: 'Ich gebe dir gern mein___ Adresse.', options: ['meine', 'meinen', 'meinem'], answer: 'meine', why: 'Akkusativ feminin → meine Adresse.' },
    { q: 'Wo sind eigentlich eur___ Fahrräder?', options: ['eure', 'euren', 'euer'], answer: 'eure', why: 'Plural Nominativ → eure Fahrräder.' },
    { q: 'Der Lehrer hat mit mein___ Vater gesprochen.', options: ['meinem', 'meinen', 'meiner'], answer: 'meinem', why: '"mit" + Dativ, maskulin → meinem Vater.' },
  ],

  personalpronomen: [
    { q: 'Kannst du ___ bitte helfen?', options: ['mir', 'mich', 'ich'], answer: 'mir', why: '"helfen" verlangt den Dativ: jemandem helfen → mir.' },
    { q: 'Ich sehe ___ morgen im Kurs.', options: ['dich', 'dir', 'du'], answer: 'dich', why: 'Akkusativobjekt (wen sehen?) → dich.' },
    { q: 'Wie geht es ___ , Frau Müller?', options: ['Ihnen', 'Sie', 'dir'], answer: 'Ihnen', why: 'Höfliche Anrede im Dativ → Ihnen. Register: der Text siezt.' },
    { q: 'Ich rufe ___ heute Abend an.', options: ['ihn', 'ihm', 'er'], answer: 'ihn', why: 'Akkusativ (wen anrufen?) → ihn.' },
    { q: 'Das Buch gehört ___ .', options: ['uns', 'wir', 'unser'], answer: 'uns', why: '"gehören" + Dativ → uns.' },
    { q: 'Kann ich ___ etwas fragen?', options: ['Sie', 'Ihnen', 'dich'], answer: 'Sie', why: 'Akkusativ der höflichen Anrede → Sie.' },
    { q: 'Ich danke ___ für die schnelle Hilfe.', options: ['dir', 'dich', 'du'], answer: 'dir', why: '"danken" + Dativ → dir.' },
    { q: 'Gib ___ bitte das Salz.', options: ['mir', 'mich', 'ich'], answer: 'mir', why: '"geben" + Dativ (wem?) → mir.' },
    { q: 'Wir treffen ___ um acht vor dem Kino.', options: ['euch', 'euche', 'ihr'], answer: 'euch', why: 'Akkusativ (wen treffen?) → euch.' },
    { q: 'Ich habe ___ seit Jahren nicht gesehen.', options: ['sie', 'ihr', 'ihnen'], answer: 'sie', why: 'Akkusativ Plural → sie.' },
    { q: 'Entschuldigung, können Sie ___ helfen?', options: ['mir', 'mich', 'ich'], answer: 'mir', why: '"helfen" + Dativ → mir.' },
    { q: 'Das ist nicht mein Problem, frag ___ selbst!', options: ['ihn', 'ihm', 'er'], answer: 'ihn', why: 'Akkusativ (wen fragen?) → ihn.' },
  ],

  temporalpraeposition: [
    { q: '___ dem Essen gehen wir noch spazieren.', options: ['Nach', 'Vor', 'Bis'], answer: 'Nach', why: '"nach" + Dativ für die Zeit danach: nach dem Essen.' },
    { q: 'Ich warte hier ___ nächsten Montag.', options: ['bis', 'in', 'seit'], answer: 'bis', why: '"bis" markiert das Ende eines Zeitraums (ohne Artikel danach).' },
    { q: '___ zwei Jahren lerne ich Deutsch.', options: ['Seit', 'Vor', 'In'], answer: 'Seit', why: '"seit" + Dativ für einen Zeitraum, der bis jetzt dauert.' },
    { q: 'Wir treffen uns ___ einer Stunde.', options: ['in', 'nach', 'vor'], answer: 'in', why: '"in" + Dativ für die Zukunft: in einer Stunde.' },
    { q: '___ drei Jahren habe ich in Rom gelebt.', options: ['Vor', 'Seit', 'Nach'], answer: 'Vor', why: '"vor" + Dativ für einen abgeschlossenen Zeitpunkt in der Vergangenheit.' },
    { q: 'Der Kurs beginnt ___ 1. September.', options: ['am', 'im', 'um'], answer: 'am', why: 'Datum mit Tag → "am" + Dativ: am 1. September.' },
    { q: 'Ich bin normalerweise ___ 8 Uhr zu Hause.', options: ['um', 'am', 'in'], answer: 'um', why: 'Uhrzeit → "um": um 8 Uhr.' },
    { q: '___ einer Woche bin ich wieder zurück.', options: ['In', 'Vor', 'Seit'], answer: 'In', why: '"in" + Dativ für einen Zeitpunkt in der Zukunft.' },
    { q: 'Er arbeitet ___ 20 Jahren bei dieser Firma.', options: ['seit', 'vor', 'bis'], answer: 'seit', why: 'Der Zeitraum dauert an → "seit 20 Jahren".' },
    { q: '___ dem Kurs treffen wir uns immer im Café.', options: ['Nach', 'Seit', 'Bis'], answer: 'Nach', why: '"nach dem Kurs" = danach (Dativ).' },
    { q: 'Wir bleiben ___ Sonntag in Berlin.', options: ['bis', 'seit', 'vor'], answer: 'bis', why: '"bis Sonntag" = Endpunkt des Aufenthalts.' },
    { q: '___ Winter fahre ich gern Ski.', options: ['Im', 'Am', 'Um'], answer: 'Im', why: 'Jahreszeit → "im" + Dativ: im Winter.' },
  ],

  konjunktiv2_hoeflich: [
    { q: '___ Sie mir bitte kurz helfen?', options: ['Könnten', 'Konnten', 'Können'], answer: 'Könnten', why: 'Konjunktiv II macht die Bitte höflich: Könnten Sie …?' },
    { q: 'Ich ___ gern einen Termin für nächste Woche.', options: ['hätte', 'hatte', 'habe'], answer: 'hätte', why: 'Höflicher Wunsch → Konjunktiv II: ich hätte gern.' },
    { q: '___ es möglich, dass Sie mich zurückrufen?', options: ['Wäre', 'War', 'Wird'], answer: 'Wäre', why: 'Höfliche Frage mit Konjunktiv II von "sein": Wäre es möglich …?' },
    { q: '___ Sie mir bitte die Adresse schicken?', options: ['Würden', 'Wurden', 'Werden'], answer: 'Würden', why: '"würden" + Infinitiv ist die höfliche Umschreibung.' },
    { q: 'Ich ___ noch ein paar Informationen.', options: ['bräuchte', 'brauchte', 'brauche'], answer: 'bräuchte', why: 'Höflicher Wunsch im Konjunktiv II: ich bräuchte.' },
    { q: 'Es ___ sehr nett, wenn Sie mir antworten würden.', options: ['wäre', 'war', 'ist'], answer: 'wäre', why: 'Irrealer/höflicher Bedingungssatz → "es wäre nett".' },
    { q: '___ ich Sie etwas fragen?', options: ['Dürfte', 'Darf', 'Durfte'], answer: 'Dürfte', why: 'Konjunktiv II von "dürfen" macht die Frage höflich.' },
    { q: 'An Ihrer Stelle ___ ich mit dem Chef sprechen.', options: ['würde', 'werde', 'wurde'], answer: 'würde', why: 'Ratschlag mit "an deiner/Ihrer Stelle" + würde + Infinitiv.' },
    { q: '___ Sie so freundlich und schicken mir das Formular?', options: ['Wären', 'Würden', 'Waren'], answer: 'Wären', why: 'Feste höfliche Wendung: Wären Sie so freundlich …?' },
    { q: 'Ich ___ mich über eine schnelle Antwort sehr freuen.', options: ['würde', 'werde', 'wurde'], answer: 'würde', why: 'Höflicher Schlusssatz im Brief: Ich würde mich freuen.' },
    { q: '___ Sie mir bitte sagen, wann der Kurs beginnt?', options: ['Könnten', 'Konnten', 'Können'], answer: 'Könnten', why: 'Höfliche Bitte mit Konjunktiv II.' },
    { q: 'Wir ___ uns sehr freuen, wenn Sie teilnehmen könnten.', options: ['würden', 'werden', 'wurden'], answer: 'würden', why: 'Konjunktiv II in der höflichen Einladung.' },
  ],

  trennbare_verben: [
    { q: 'Ich rufe dich heute Abend ___ .', options: ['an', 'auf', 'aus'], answer: 'an', why: '"anrufen" ist trennbar: ich rufe … an.' },
    { q: 'Der Zug kommt um 8 Uhr ___ .', options: ['an', 'ab', 'auf'], answer: 'an', why: '"ankommen" → kommt … an.' },
    { q: 'Wir laden unsere Freunde zum Essen ___ .', options: ['ein', 'aus', 'an'], answer: 'ein', why: '"einladen" → laden … ein.' },
    { q: 'Ich stehe jeden Morgen um 6 Uhr ___ .', options: ['auf', 'an', 'aus'], answer: 'auf', why: '"aufstehen" → stehe … auf.' },
    { q: 'Wir fahren am Freitag ___ .', options: ['ab', 'an', 'auf'], answer: 'ab', why: '"abfahren" → fahren … ab.' },
    { q: 'Mach bitte das Licht ___ .', options: ['aus', 'an', 'ab'], answer: 'aus', why: '"ausmachen" → mach … aus.' },
    { q: 'Ich hole meine Freundin vom Bahnhof ___ .', options: ['ab', 'an', 'auf'], answer: 'ab', why: '"abholen" → hole … ab.' },
    { q: 'Er zieht seine Jacke ___ .', options: ['an', 'aus', 'auf'], answer: 'an', why: '"anziehen" → zieht … an.' },
    { q: 'Ich schlage das Wort im Wörterbuch ___ .', options: ['nach', 'auf', 'an'], answer: 'nach', why: '"nachschlagen" → schlage … nach.' },
    { q: 'Die Party fängt um 20 Uhr ___ .', options: ['an', 'auf', 'aus'], answer: 'an', why: '"anfangen" → fängt … an.' },
    { q: 'Bitte füllen Sie das Formular ___ .', options: ['aus', 'an', 'ab'], answer: 'aus', why: '"ausfüllen" → füllen … aus.' },
    { q: 'Ich mache das Fenster ___ , es ist warm hier.', options: ['auf', 'an', 'aus'], answer: 'auf', why: '"aufmachen" → mache … auf.' },
  ],

  modalverben: [
    { q: 'Ich ___ heute länger arbeiten.', options: ['muss', 'musst', 'müssen'], answer: 'muss', why: '1. Person Singular: ich muss.' },
    { q: '___ ich hier rauchen?', options: ['Darf', 'Darfst', 'Dürfen'], answer: 'Darf', why: 'Erlaubnis erfragen: Darf ich …? (ich-Form).' },
    { q: 'Du ___ mehr schlafen, du siehst müde aus.', options: ['solltest', 'sollst', 'sollte'], answer: 'solltest', why: 'Ratschlag an "du" → solltest.' },
    { q: 'Wir ___ am Wochenende nach Hamburg fahren.', options: ['wollen', 'wollt', 'will'], answer: 'wollen', why: '1. Person Plural: wir wollen.' },
    { q: 'Sie ___ sehr gut Klavier spielen.', options: ['kann', 'können', 'kannst'], answer: 'kann', why: '"sie" (Singular) → kann.' },
    { q: 'Ich ___ gern ein Glas Wasser, bitte.', options: ['möchte', 'möchte gern', 'mag'], answer: 'möchte', why: 'Höflicher Wunsch: ich möchte.' },
    { q: 'Kinder ___ im Museum nicht rennen.', options: ['dürfen', 'dürft', 'darf'], answer: 'dürfen', why: 'Plural: Kinder dürfen.' },
    { q: 'Er ___ gestern leider nicht kommen.', options: ['konnte', 'kann', 'könnte'], answer: 'konnte', why: 'Vergangenheit von "können" → konnte.' },
    { q: 'Ihr ___ die Hausaufgaben bis Freitag machen.', options: ['müsst', 'muss', 'müssen'], answer: 'müsst', why: '2. Person Plural: ihr müsst.' },
    { q: '___ du mir bitte helfen?', options: ['Kannst', 'Kann', 'Können'], answer: 'Kannst', why: '2. Person Singular: kannst.' },
    { q: 'Man ___ hier nicht parken.', options: ['darf', 'darfst', 'dürfen'], answer: 'darf', why: '"man" ist immer Singular → darf.' },
    { q: 'Wir ___ heute leider nicht ins Kino gehen.', options: ['können', 'könnt', 'kann'], answer: 'können', why: '1. Person Plural: wir können.' },
  ],

  komparativ: [
    { q: 'Mein Bruder ist ___ als ich.', options: ['größer', 'großer', 'am größten'], answer: 'größer', why: 'Komparativ mit "als": größer als.' },
    { q: 'Dieser Weg ist ___ als der andere.', options: ['kürzer', 'kurzer', 'am kürzesten'], answer: 'kürzer', why: 'kurz → kürzer (Umlaut im Komparativ).' },
    { q: 'Der Winter in Russland ist ___ als in Italien.', options: ['kälter', 'kalter', 'am kältesten'], answer: 'kälter', why: 'kalt → kälter (Umlaut).' },
    { q: 'Sie spricht ___ Deutsch als ich.', options: ['besser', 'guter', 'am besten'], answer: 'besser', why: 'gut → besser (unregelmäßig).' },
    { q: 'Das ist das ___ Restaurant in der Stadt.', options: ['beste', 'bessere', 'guteste'], answer: 'beste', why: 'Superlativ von "gut" → beste.' },
    { q: 'Ich fahre lieber mit dem Zug, das ist viel ___ .', options: ['bequemer', 'bequem', 'am bequemsten'], answer: 'bequemer', why: 'Komparativ: bequem → bequemer.' },
    { q: 'Der Everest ist der ___ Berg der Welt.', options: ['höchste', 'höhere', 'hochste'], answer: 'höchste', why: 'Superlativ von "hoch" → höchste.' },
    { q: 'Meine Wohnung ist ___ als deine.', options: ['kleiner', 'klein', 'am kleinsten'], answer: 'kleiner', why: 'Komparativ mit "als": kleiner als.' },
    { q: 'Im Sommer sind die Tage ___ als im Winter.', options: ['länger', 'langer', 'am längsten'], answer: 'länger', why: 'lang → länger (Umlaut).' },
    { q: 'Dieses Buch ist ___ als das andere.', options: ['interessanter', 'interessant', 'am interessantesten'], answer: 'interessanter', why: 'Komparativ auf -er: interessanter als.' },
    { q: 'Sie ist die ___ Mitarbeiterin im Team.', options: ['erfahrenste', 'erfahrenere', 'erfahren'], answer: 'erfahrenste', why: 'Superlativ mit bestimmtem Artikel → erfahrenste.' },
    { q: 'Je mehr ich lerne, ___ wird mein Deutsch.', options: ['besser', 'gut', 'am besten'], answer: 'besser', why: 'Vergleich "je … desto" → Komparativ: besser.' },
  ],

  wortstellung_nebensatz: [
    { q: 'Ich weiß, dass er morgen nach Berlin ___ .', options: ['fährt', 'er fährt', 'fahren'], answer: 'fährt', why: 'Im Nebensatz steht das konjugierte Verb am Ende: … dass er morgen nach Berlin fährt.' },
    { q: 'Sie kommt heute nicht, weil sie ___ .', options: ['krank ist', 'ist krank', 'krank sein'], answer: 'krank ist', why: 'Nach "weil" steht das Verb am Satzende.' },
    { q: 'Ich rufe dich an, wenn ich ___ .', options: ['Zeit habe', 'habe Zeit', 'Zeit haben'], answer: 'Zeit habe', why: 'Nebensatz mit "wenn" → Verb am Ende.' },
    { q: 'Er sagt, dass er das Buch schon ___ .', options: ['gelesen hat', 'hat gelesen', 'gelesen haben'], answer: 'gelesen hat', why: 'Im Nebensatz steht das Hilfsverb nach dem Partizip am Ende.' },
    { q: 'Ich habe gehört, dass du ___ .', options: ['umgezogen bist', 'bist umgezogen', 'umgezogen sein'], answer: 'umgezogen bist', why: 'Perfekt im Nebensatz: Partizip + Hilfsverb am Ende.' },
    { q: 'Obwohl es stark ___ , sind wir spazieren gegangen.', options: ['geregnet hat', 'hat geregnet', 'regnen hat'], answer: 'geregnet hat', why: 'Nach "obwohl" steht das Verb am Ende.' },
    { q: 'Ich bleibe zu Hause, weil ich sehr ___ .', options: ['müde bin', 'bin müde', 'müde sein'], answer: 'müde bin', why: 'Verb am Ende im "weil"-Satz.' },
    { q: 'Weißt du, wann der Zug ___ ?', options: ['abfährt', 'fährt ab', 'abfahren'], answer: 'abfährt', why: 'Indirekte Frage: trennbares Verb bleibt zusammen am Ende.' },
    { q: 'Ich möchte wissen, ob du ___ .', options: ['mitkommst', 'kommst mit', 'mitkommen'], answer: 'mitkommst', why: 'Nach "ob" steht das Verb am Ende – trennbares Verb zusammen.' },
    { q: 'Sie hat gesagt, dass sie uns später ___ .', options: ['anruft', 'ruft an', 'anrufen'], answer: 'anruft', why: 'Im Nebensatz bleibt das trennbare Verb am Ende zusammen.' },
    { q: 'Ich habe ihn gefragt, wo er ___ .', options: ['wohnt', 'wohnt er', 'wohnen'], answer: 'wohnt', why: 'Indirekte Frage: Verb am Ende.' },
    { q: 'Es ist wichtig, dass du pünktlich ___ .', options: ['kommst', 'kommst du', 'kommen'], answer: 'kommst', why: '"dass"-Satz → konjugiertes Verb am Ende.' },
  ],

  negation: [
    { q: 'Ich habe leider ___ Zeit für dich.', options: ['keine', 'nicht', 'nichts'], answer: 'keine', why: 'Substantiv mit Artikel → Negation mit "kein": keine Zeit.' },
    { q: 'Das ist ___ mein Buch, das ist deins.', options: ['nicht', 'kein', 'keine'], answer: 'nicht', why: 'Nicht ein Substantiv, sondern der ganze Satzteil wird negiert → "nicht".' },
    { q: 'Ich habe davon ___ verstanden.', options: ['nichts', 'nicht', 'kein'], answer: 'nichts', why: '"nichts" = nothing, eigenständiges Pronomen.' },
    { q: 'Er kommt heute leider ___ .', options: ['nicht', 'kein', 'nichts'], answer: 'nicht', why: 'Verb negieren → "nicht".' },
    { q: 'Ich habe ___ Geld dabei.', options: ['kein', 'keine', 'nicht'], answer: 'kein', why: '"das Geld" → Neutrum → kein Geld.' },
    { q: 'Sie hat ___ Interesse an Sport.', options: ['kein', 'keine', 'nicht'], answer: 'kein', why: '"das Interesse" → Neutrum → kein Interesse.' },
    { q: 'Wir waren ___ in Paris.', options: ['nie', 'nicht', 'kein'], answer: 'nie', why: '"nie" = never, verstärkt die Verneinung der Zeit.' },
    { q: 'Das ist wirklich ___ Problem.', options: ['kein', 'keine', 'nicht'], answer: 'kein', why: '"das Problem" → Neutrum → kein Problem.' },
    { q: 'Ich kenne hier ___ .', options: ['niemanden', 'nicht', 'keinen'], answer: 'niemanden', why: '"niemand" im Akkusativ → niemanden.' },
    { q: 'Er hat ___ Zeit für Hobbys.', options: ['keine', 'kein', 'nicht'], answer: 'keine', why: '"die Zeit" ist feminin → keine Zeit.' },
    { q: 'Ich verstehe dich ___ .', options: ['nicht', 'kein', 'nichts'], answer: 'nicht', why: 'Verb negieren → nicht.' },
    { q: 'Wir haben ___ Lust mehr.', options: ['keine', 'kein', 'nicht'], answer: 'keine', why: '"die Lust" ist feminin → keine Lust.' },
  ],

  /* ----------------------------------------------------------- Wortschatz */

  lexik_verben_praeposition: [
    { q: 'Ich warte schon zehn Minuten ___ den Bus.', options: ['auf', 'für', 'an'], answer: 'auf', why: 'Feste Verbindung: warten auf + Akkusativ.' },
    { q: 'Sie freut sich sehr ___ das Geschenk.', options: ['über', 'auf', 'für'], answer: 'über', why: '"sich freuen über" = Freude über etwas, das schon da ist.' },
    { q: 'Ich interessiere mich sehr ___ Musik.', options: ['für', 'an', 'über'], answer: 'für', why: 'sich interessieren für + Akkusativ.' },
    { q: 'Er denkt oft ___ seine Familie.', options: ['an', 'über', 'auf'], answer: 'an', why: 'denken an + Akkusativ = an jemanden denken.' },
    { q: 'Wir nehmen gern ___ deinem Kurs teil.', options: ['an', 'in', 'bei'], answer: 'an', why: 'teilnehmen an + Dativ.' },
    { q: 'Ich kümmere mich ___ meine Großmutter.', options: ['um', 'für', 'über'], answer: 'um', why: 'sich kümmern um + Akkusativ.' },
    { q: 'Ich habe mich ___ das Ergebnis sehr geärgert.', options: ['über', 'auf', 'für'], answer: 'über', why: 'sich ärgern über + Akkusativ.' },
    { q: 'Ich träume ___ einem eigenen Haus.', options: ['von', 'über', 'an'], answer: 'von', why: 'träumen von + Dativ.' },
    { q: 'Wir sprechen morgen ___ das Problem.', options: ['über', 'auf', 'für'], answer: 'über', why: 'sprechen über + Akkusativ.' },
    { q: 'Sie hat sich ___ ihren Kollegen entschuldigt.', options: ['bei', 'mit', 'zu'], answer: 'bei', why: 'sich entschuldigen bei + Dativ (Person).' },
    { q: 'Ich freue mich schon ___ den Urlaub.', options: ['auf', 'über', 'an'], answer: 'auf', why: '"sich freuen auf" = Vorfreude auf etwas Zukünftiges.' },
    { q: 'Er hat ___ seine Prüfung nicht bestanden.', options: ['in', 'an', 'bei'], answer: 'in', why: 'bestanden in + Dativ (Prüfungsfach): in der Prüfung.' },
    // The highest-frequency telc B1 verb+preposition pairs. The exam reuses a small
    // set of these, and they appear verbatim in Sprachbausteine Teil 2.
    { q: 'Sie bewirbt sich ___ eine Stelle als Ärztin.', options: ['um', 'für', 'auf'], answer: 'um', why: 'sich bewerben um + Akkusativ (die Stelle).' },
    { q: 'Ich erinnere mich gern ___ meine Kindheit.', options: ['an', 'auf', 'über'], answer: 'an', why: 'sich erinnern an + Akkusativ.' },
    { q: 'Er hat mich ___ einen Gefallen gebeten.', options: ['um', 'für', 'nach'], answer: 'um', why: 'bitten um + Akkusativ (der Gefallen).' },
    { q: 'Wir haben uns ___ ein neues Auto entschieden.', options: ['für', 'auf', 'zu'], answer: 'für', why: 'sich entscheiden für + Akkusativ.' },
    { q: 'Dieses Lied gehört ___ meiner Kindheit.', options: ['zu', 'in', 'bei'], answer: 'zu', why: 'gehören zu + Dativ = zu etwas dazugehören. Ohne Präposition steht nur der Dativ: Das Buch gehört mir.' },
    { q: 'Der Kurs besteht ___ zwölf Teilnehmern.', options: ['aus', 'von', 'mit'], answer: 'aus', why: 'bestehen aus + Dativ = aus etwas zusammengesetzt sein.' },
    { q: 'Ich beschäftige mich gerade ___ einem neuen Projekt.', options: ['mit', 'an', 'über'], answer: 'mit', why: 'sich beschäftigen mit + Dativ.' },
    { q: 'Das hängt ___ Wetter ab.', options: ['vom', 'von', 'aus'], answer: 'vom', why: 'abhängen von + Dativ; "von dem" wird zu "vom".' },
    { q: 'Bitte achten Sie ___ die Regeln.', options: ['auf', 'an', 'für'], answer: 'auf', why: 'achten auf + Akkusativ.' },
    { q: 'Ich bereite mich ___ die Prüfung vor.', options: ['auf', 'für', 'zu'], answer: 'auf', why: 'sich vorbereiten auf + Akkusativ.' },
    { q: 'Er träumt ___ einer Weltreise.', options: ['von', 'über', 'an'], answer: 'von', why: 'träumen von + Dativ.' },
    { q: 'Wir haben uns lange ___ das Problem unterhalten.', options: ['über', 'von', 'an'], answer: 'über', why: 'sich unterhalten über + Akkusativ.' },
    { q: 'Ich bedanke mich herzlich ___ Ihre Hilfe.', options: ['für', 'über', 'auf'], answer: 'für', why: 'sich bedanken für + Akkusativ.' },
    { q: 'Sie hat ___ dem Weg zum Bahnhof gefragt.', options: ['nach', 'für', 'über'], answer: 'nach', why: 'fragen nach + Dativ.' },
    { q: 'Wir suchen noch ___ einer günstigen Wohnung.', options: ['nach', 'für', 'auf'], answer: 'nach', why: 'suchen nach + Dativ.' },
    { q: 'Ich treffe mich morgen ___ meinen Freunden.', options: ['mit', 'bei', 'zu'], answer: 'mit', why: 'sich treffen mit + Dativ.' },
    { q: 'Bist du ___ deiner Note zufrieden?', options: ['mit', 'über', 'von'], answer: 'mit', why: 'zufrieden sein mit + Dativ.' },
    { q: 'Sie hat Angst ___ großen Hunden.', options: ['vor', 'von', 'für'], answer: 'vor', why: 'Angst haben vor + Dativ.' },
    { q: 'Hast du Lust ___ einen Kaffee?', options: ['auf', 'für', 'zu'], answer: 'auf', why: 'Lust haben auf + Akkusativ.' },
    { q: 'Ich habe heute leider keine Zeit ___ Sport.', options: ['für', 'zu', 'auf'], answer: 'für', why: 'Zeit haben für + Akkusativ.' },
  ],
};

/* ------------------------------------------------------------------ engine */

const BASE_DIFFICULTY = {
  konnektoren: 52,
  praeposition_kasus: 50,
  wechselpraeposition: 58,
  perfekt_auxiliar: 42,
  partizip2: 48,
  adjektivendungen: 60,
  relativpronomen: 62,
  possessivartikel: 50,
  personalpronomen: 45,
  temporalpraeposition: 55,
  konjunktiv2_hoeflich: 62,
  trennbare_verben: 42,
  modalverben: 38,
  komparativ: 45,
  wortstellung_nebensatz: 60,
  negation: 40,
  lexik_verben_praeposition: 58,
};

export const OFFLINE_TAGS = Object.keys(POOLS);

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

export function baseDifficulty(tag) {
  return BASE_DIFFICULTY[tag] ?? 55;
}

/**
 * Build one multiple-choice grammar drill for a tag.
 * @param {string} tag
 * @param {{targetDifficulty?:number, avoid?:string[]}} opts
 */
export function generateDrill(tag, opts = {}) {
  const pool = POOLS[tag];
  if (!pool || !pool.length) return null;
  const avoid = new Set(opts.avoid || []);
  const target = Number.isFinite(opts.targetDifficulty) ? opts.targetDifficulty : baseDifficulty(tag);

  // Prefer unseen prompts, and among those the one closest to the target difficulty.
  const scored = pool.map((item, idx) => {
    const jitter = ((parseInt(hash(item.q) , 36) % 9) - 4); // stable per-item spread
    const difficulty = Math.max(20, Math.min(90, baseDifficulty(tag) + jitter));
    return { item, idx, difficulty, seen: avoid.has(item.q) ? 1 : 0 };
  });
  scored.sort((a, b) => {
    if (a.seen !== b.seen) return a.seen - b.seen;
    return Math.abs(a.difficulty - target) - Math.abs(b.difficulty - target);
  });
  const chosen = scored[0];

  const options = shuffle(chosen.item.options).map((text, i) => ({
    key: String.fromCharCode(97 + i),
    text,
  }));
  const answerKey = options.find((o) => o.text === chosen.item.answer)?.key || 'a';

  return {
    id: `g_${tag}_${hash(chosen.item.q)}`,
    kind: 'mc3',
    partId: 'SB1',
    tag,
    tags: [tag],
    difficulty: chosen.difficulty,
    instruction: 'Welche Lösung ist richtig?',
    prompt: chosen.item.q,
    options,
    answerKey,
    answer: chosen.item.answer,
    explanation: chosen.item.why,
    source: 'offline',
  };
}

/**
 * How to mention a noun's plural in an explanation. A Singularetantum carries the
 * marker "kein Plural" rather than an invented form, and that deserves a real
 * sentence instead of "Plural: kein Plural".
 */
function pluralNote(plural) {
  if (!plural) return '';
  if (plural === 'kein Plural') return ' – kein Plural';
  return ` – Plural: ${plural}`;
}

/** The example sentence, with its translation only when one exists. */
function exampleLine(entry) {
  if (!entry?.example) return '';
  return entry.exampleEn ? `${entry.example} — ${entry.exampleEn}` : entry.example;
}

/** "der Nachbar — <example> (neighbour)", dropping the translation when absent. */
function exampleWithTranslation(headword, entry) {
  if (!entry?.example) return headword;
  return entry.exampleEn
    ? `${headword} — ${entry.example} (${entry.exampleEn})`
    : `${headword} — ${entry.example}`;
}

/**
 * Turn a vocabulary entry into a drill card.
 * mode: 'de-en' (meaning), 'en-de' (production), 'article' (der/die/das).
 */
export function vocabDrill(entry, mode) {
  if (!entry) return null;
  const m = mode || (entry.pos === 'noun' && Math.random() < 0.34 ? 'article' : Math.random() < 0.5 ? 'de-en' : 'en-de');

  if (m === 'article' && entry.pos === 'noun') {
    const correct = (entry.de.match(/^(der|die|das)\s/) || [])[1];
    if (!correct) return null;
    const noun = entry.de.replace(/^(der|die|das)\s/, '');
    return {
      id: `v_art_${entry.de}`,
      kind: 'mc3',
      partId: 'SB1',
      tag: 'lexik_wortbildung',
      tags: ['lexik_wortbildung'],
      difficulty: 42,
      instruction: 'Welcher Artikel ist richtig?',
      prompt: `___ ${noun}   (${entry.en})`,
      options: shuffle(['der', 'die', 'das']).map((t, i) => ({ key: String.fromCharCode(97 + i), text: t })),
      answerKey: null, // filled below
      answer: correct,
      explanation: `${entry.de}${entry.en ? ` (${entry.en})` : ''}${pluralNote(entry.plural)}. Beispiel: ${exampleLine(entry)}`,
      source: 'offline',
    };
  }

  if (m === 'en-de') {
    const distractors = [];
    const correct = entry.de;
    return {
      id: `v_prod_${entry.de}`,
      kind: 'typein',
      partId: 'SA1',
      tag: 'sa_wortschatz',
      tags: ['sa_wortschatz', 'lexik_synonyme'],
      difficulty: 62,
      instruction: 'Schreibe das deutsche Wort (mit Artikel bei Nomen).',
      prompt: entry.en,
      options: [],
      answer: correct,
      accept: [correct, correct.replace(/^(der|die|das)\s/, '')],
      explanation: exampleWithTranslation(correct, entry),
      source: 'offline',
      distractors,
    };
  }

  // de-en: recognition. Needs options, so caller supplies a distractor set.
  return {
    id: `v_rec_${entry.de}`,
    kind: 'mc3',
    partId: 'LV2',
    tag: 'lexik_synonyme',
    tags: ['lexik_synonyme'],
    difficulty: 50,
    instruction: 'Was bedeutet das?',
    prompt: entry.de,
    options: [],
    answer: entry.en,
    explanation: exampleLine(entry),
    source: 'offline',
    needsDistractors: 'en',
  };
}

/** Fill in options for a vocab recognition card from other deck entries. */
export function withVocabDistractors(card, deck, field) {
  if (!card || !card.needsDistractors) return card;
  const pool = shuffle(deck.filter((w) => w[field] && w[field] !== card.answer)).slice(0, 2);
  if (pool.length < 2) return card;
  const opts = shuffle([card.answer, ...pool.map((w) => w[field])]);
  card.options = opts.map((text, i) => ({ key: String.fromCharCode(97 + i), text }));
  card.answerKey = card.options.find((o) => o.text === card.answer)?.key || 'a';
  delete card.needsDistractors;
  return card;
}

/** Finalise answerKey for cards built before option shuffling. */
export function finalizeCard(card) {
  if (card && card.options && card.options.length && !card.answerKey) {
    const hit = card.options.find((o) => o.text === card.answer);
    card.answerKey = hit ? hit.key : null;
  }
  return card;
}
