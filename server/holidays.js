'use strict';
/**
 * The public holidays of a country for a year, by rule — no network, no dependency (plan L48 R3).
 *
 *   holidays('US', 2026)           → [{ date: '2026-11-26', name: 'Thanksgiving Day', country: 'US' }, …]
 *   countryOfZone('Europe/Berlin') → 'DE'
 *   resolveCountry({ query, cookie, tz }) → 'FR' (the ?country=, else the cookie, else the zone)
 *
 * A holiday is a day, not an instant: the week puts it at the top of its day, like an imported all-day
 * event. The rules are the ones each country's own list states:
 *   - a fixed date (1 January), sometimes moved when it lands on a weekend: the United States takes a
 *     Saturday holiday on the Friday before and a Sunday one on the Monday after (5 U.S.C. § 6103);
 *     Britain, Canada, Ireland and Australia take the Monday; New Zealand takes the Monday or the Tuesday;
 *   - the nth weekday of a month (the fourth Thursday of November is Thanksgiving Day);
 *   - the last weekday of a month (the last Monday of May is Memorial Day in the United States);
 *   - Easter and the days counted from it (Good Friday is two days before Easter, Whit Monday fifty after).
 *
 * Only what an official list states is here. A country whose list cannot be stated is left out rather than
 * guessed, and a country keeps the holidays its own law names nationally (India's gazetted three, Britain's
 * England and Wales list, Australia's national eight). The sources:
 *
 *   US  federal:       https://www.opm.gov/policy-data-oversight/pay-leave/federal-holidays/ (5 U.S.C. § 6103)
 *   CA  federal:       https://www.canada.ca/en/revenue-agency/services/tax/public-holidays.html
 *   GB  England/Wales: https://www.gov.uk/bank-holidays
 *   IE:                https://www.citizensinformation.ie/en/employment/employment-rights/leave-and-holidays/public-holidays-in-ireland/
 *   AU  national:      https://www.fairwork.gov.au/employment-conditions/public-holidays
 *   NZ:                https://www.employment.govt.nz/leave-and-holidays/public-holidays/public-holidays-and-anniversary-dates/
 *   DE  national:      https://www.gesetze-im-internet.de/arbzg/__9.html (Arbeitszeitgesetz § 9)
 *   FR  national:      https://www.service-public.fr/particuliers/vosdroits/F2405
 *   ES  national:      https://www.boe.es/buscar/act.php?id=BOE-A-1983-21506 (Real Decreto 2001/1983, art. 45)
 *   IT  national:      https://www.normattiva.it/uri-res/N2Ls?urn:nir:stato:legge:1949-12-27;260 (legge 260/1949)
 *   NL  national:      https://wetten.overheid.nl/BWBR0007670/ (Arbeidstijdenwet, art. 2)
 *   BR  national:      https://www.planalto.gov.br/ccivil_03/leis/l216/l216.htm (Lei 662/1949, Lei 10.607/2002)
 *   MX  national:      https://www.diputados.gob.mx/LeyesBiblio/pdf/LFT.pdf (Ley Federal del Trabajo, art. 74)
 *   IN  gazetted:      https://www.indiacode.nic.in/ (the three holidays the gazette names)
 *   JP  national:      https://www8.cao.go.jp/chosatu/ (Cabinet Office, national holidays)
 *
 * This is the rule book for the week (server/week.js). The other holiday reader in this service,
 * server/imports/holidays.js, is a different thing: it imports the network's holiday events from an open
 * dataset for the public pages.
 */

const pad = (n) => String(n).padStart(2, '0');
const key = (d) => `${d.y}-${pad(d.m)}-${pad(d.d)}`;
const dow = (y, m, d) => new Date(Date.UTC(y, m - 1, d)).getUTCDay();   // 0 Sunday … 6 Saturday
const addDays = (y, m, d, n) => {
    const t = new Date(Date.UTC(y, m - 1, d + n));
    return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
};

/** The nth weekday of a month (weekday 1 Monday … 7 Sunday), the first when n is 1. */
function nthWeekday(y, m, weekday, n) {
    const first = dow(y, m, 1);
    const offset = (8 - first) % 7;                             // days from the 1st to the first Monday
    return { y, m, d: 1 + offset + (weekday - 1) + (n - 1) * 7 };
}

/** The last weekday of a month (weekday 1 Monday … 7 Sunday). */
function lastWeekday(y, m, weekday) {
    const last = new Date(Date.UTC(y, m, 0));
    const lastDow = last.getUTCDay() === 0 ? 7 : last.getUTCDay();
    return { y, m, d: last.getUTCDate() - (lastDow - weekday) };
}

/** The Monday of the week before a date: the Monday strictly before it. */
function mondayBefore(y, m, d) {
    const day = dow(y, m, d);
    const back = day === 1 ? 7 : day === 0 ? 6 : day - 1;
    return addDays(y, m, d, -back);
}

/** Easter Sunday, Western (Gregorian) computus. */
function easter(y) {
    const a = y % 19;
    const b = Math.floor(y / 100);
    const c = y % 100;
    const d = Math.floor(b / 4);
    const e = b % 4;
    const f = Math.floor((b + 8) / 25);
    const g = Math.floor((b - f + 1) / 3);
    const h = (19 * a + b - d - g + 15) % 30;
    const i = Math.floor(c / 4);
    const k = c % 4;
    const l = (32 + 2 * e + 2 * i - h - k) % 7;
    const m = Math.floor((a + 11 * h + 22 * l) / 451);
    const month = Math.floor((h + l - 7 * m + 114) / 31);
    const day = ((h + l - 7 * m + 114) % 31) + 1;
    return { y, m: month, d: day };
}

/** Easter and the days counted from it: Good Friday is −2, Easter Monday +1, Ascension +39, Whit Monday +50. */
function fromEaster(y, offset) {
    const e = easter(y);
    return addDays(y, e.m, e.d, offset);
}

/** A Saturday holiday is taken the Friday before, a Sunday one the Monday after (the United States). */
function usObserved(y, m, d) {
    const day = dow(y, m, d);
    if (day === 6) return addDays(y, m, d, -1);
    if (day === 0) return addDays(y, m, d, 1);
    return { y, m, d };
}

/** A holiday on a weekend is taken the Monday after (Britain, Canada, Ireland, Australia, most states). */
function mondayIfWeekend(y, m, d) {
    const day = dow(y, m, d);
    if (day === 6) return addDays(y, m, d, 2);
    if (day === 0) return addDays(y, m, d, 1);
    return { y, m, d };
}

/**
 * Christmas Day and Boxing Day together, as Britain, Canada, Ireland and Australia take them: a
 * Saturday Christmas is taken Monday and Tuesday, a Sunday Christmas Tuesday and Monday, and a
 * Saturday Boxing Day the Monday after.
 */
function christmasPair(y) {
    const c = dow(y, 12, 25);
    if (c === 6) return { christmas: { y, m: 12, d: 27 }, boxing: { y, m: 12, d: 28 } };
    if (c === 0) return { christmas: { y, m: 12, d: 27 }, boxing: { y, m: 12, d: 26 } };
    if (c === 5) return { christmas: { y, m: 12, d: 25 }, boxing: { y, m: 12, d: 28 } };
    return { christmas: { y, m: 12, d: 25 }, boxing: { y, m: 12, d: 26 } };
}

/** The United States (federal): the eleven days OPM lists. */
function us(y) {
    const out = [];
    const add = (dt, name) => out.push({ ...dt, name });
    add(usObserved(y, 1, 1), "New Year's Day");
    add(nthWeekday(y, 1, 1, 3), 'Birthday of Martin Luther King, Jr.');
    add(nthWeekday(y, 2, 1, 3), "Washington's Birthday");
    add(lastWeekday(y, 5, 1), 'Memorial Day');
    if (y >= 2021) add(usObserved(y, 6, 19), 'Juneteenth National Independence Day');
    add(usObserved(y, 7, 4), 'Independence Day');
    add(nthWeekday(y, 9, 1, 1), 'Labor Day');
    add(nthWeekday(y, 10, 1, 2), 'Columbus Day');
    add(usObserved(y, 11, 11), 'Veterans Day');
    add(nthWeekday(y, 11, 4, 4), 'Thanksgiving Day');
    add(usObserved(y, 12, 25), 'Christmas Day');
    return out;
}

/** Canada (the federal statutory holidays the CRA lists). */
function ca(y) {
    const out = [];
    const add = (dt, name) => out.push({ ...dt, name });
    // New Year's Day: a Saturday is taken the Friday before, the last day of the year before.
    if (dow(y, 1, 1) === 6) add(addDays(y, 1, 1, -1), "New Year's Day");
    else add(mondayIfWeekend(y, 1, 1), "New Year's Day");
    add(fromEaster(y, -2), 'Good Friday');
    add(fromEaster(y, 1), 'Easter Monday');
    add(mondayBefore(y, 5, 25), 'Victoria Day');
    add(mondayIfWeekend(y, 7, 1), 'Canada Day');
    add(nthWeekday(y, 9, 1, 1), 'Labour Day');
    if (y >= 2021) add({ y, m: 9, d: 30 }, 'National Day for Truth and Reconciliation');
    add(nthWeekday(y, 10, 1, 2), 'Thanksgiving Day');
    add({ y, m: 11, d: 11 }, 'Remembrance Day');
    const pair = christmasPair(y);
    add(pair.christmas, 'Christmas Day');
    add(pair.boxing, 'Boxing Day');
    return out;
}

/** Great Britain (England and Wales): the bank holidays gov.uk lists. */
function gb(y) {
    const out = [];
    const add = (dt, name) => out.push({ ...dt, name });
    add(mondayIfWeekend(y, 1, 1), "New Year's Day");
    add(fromEaster(y, -2), 'Good Friday');
    add(fromEaster(y, 1), 'Easter Monday');
    add(nthWeekday(y, 5, 1, 1), 'Early May bank holiday');
    add(lastWeekday(y, 5, 1), 'Spring bank holiday');
    add(lastWeekday(y, 8, 1), 'Summer bank holiday');
    const pair = christmasPair(y);
    add(pair.christmas, 'Christmas Day');
    add(pair.boxing, 'Boxing Day');
    return out;
}

/** Ireland: the public holidays citizensinformation.ie lists (St Brigid's Day since 2023). */
function ie(y) {
    const out = [];
    const add = (dt, name) => out.push({ ...dt, name });
    add(mondayIfWeekend(y, 1, 1), "New Year's Day");
    if (y >= 2023) add(nthWeekday(y, 2, 1, 1), "St Brigid's Day");
    add({ y, m: 3, d: 17 }, "St Patrick's Day");
    add(fromEaster(y, 1), 'Easter Monday');
    add(nthWeekday(y, 5, 1, 1), 'May Bank Holiday');
    add(nthWeekday(y, 6, 1, 1), 'June Bank Holiday');
    add(nthWeekday(y, 8, 1, 1), 'August Bank Holiday');
    add(lastWeekday(y, 10, 1), 'October Bank Holiday');
    const pair = christmasPair(y);
    add(pair.christmas, 'Christmas Day');
    add(pair.boxing, "St Stephen's Day");
    return out;
}

/** Australia (the national public holidays Fair Work lists; the states add a few of their own). */
function au(y) {
    const out = [];
    const add = (dt, name) => out.push({ ...dt, name });
    add(mondayIfWeekend(y, 1, 1), "New Year's Day");
    add(mondayIfWeekend(y, 1, 26), 'Australia Day');
    add(fromEaster(y, -2), 'Good Friday');
    add(fromEaster(y, 1), 'Easter Monday');
    add({ y, m: 4, d: 25 }, 'Anzac Day');
    add(nthWeekday(y, 6, 1, 2), y >= 2023 ? "King's Birthday" : "Queen's Birthday");
    const pair = christmasPair(y);
    add(pair.christmas, 'Christmas Day');
    add(pair.boxing, 'Boxing Day');
    return out;
}

/** New Zealand: the holidays that are Mondayised when they land on a weekend. */
function nz(y) {
    const out = [];
    const add = (dt, name) => out.push({ ...dt, name });
    // New Year's Day and the day after: a Saturday New Year is taken Monday and Tuesday.
    const ny = dow(y, 1, 1);
    if (ny === 6) { add({ y, m: 1, d: 3 }, "New Year's Day"); add({ y, m: 1, d: 4 }, "Day after New Year's Day"); }
    else if (ny === 0) { add({ y, m: 1, d: 2 }, "New Year's Day"); add({ y, m: 1, d: 3 }, "Day after New Year's Day"); }
    else if (ny === 1) { add({ y, m: 1, d: 1 }, "New Year's Day"); add({ y, m: 1, d: 2 }, "Day after New Year's Day"); }
    else { add({ y, m: 1, d: 1 }, "New Year's Day"); add(mondayIfWeekend(y, 1, 2), "Day after New Year's Day"); }
    add(mondayIfWeekend(y, 2, 6), 'Waitangi Day');
    add(fromEaster(y, -2), 'Good Friday');
    add(fromEaster(y, 1), 'Easter Monday');
    add(mondayIfWeekend(y, 4, 25), 'Anzac Day');
    add(nthWeekday(y, 6, 1, 1), y >= 2023 ? "King's Birthday" : "Queen's Birthday");
    add(nthWeekday(y, 10, 1, 4), 'Labour Day');
    // Christmas and Boxing Day: a Sunday Christmas is taken Monday and Tuesday.
    const c = dow(y, 12, 25);
    if (c === 6) { add({ y, m: 12, d: 27 }, 'Christmas Day'); add({ y, m: 12, d: 28 }, 'Boxing Day'); }
    else if (c === 0) { add({ y, m: 12, d: 26 }, 'Christmas Day'); add({ y, m: 12, d: 27 }, 'Boxing Day'); }
    else { add({ y, m: 12, d: 25 }, 'Christmas Day'); add(mondayIfWeekend(y, 12, 26), 'Boxing Day'); }
    return out;
}

/** Germany: the nine days the Arbeitszeitgesetz § 9 names. */
function de(y) {
    const out = [];
    const add = (dt, name) => out.push({ ...dt, name });
    add({ y, m: 1, d: 1 }, 'Neujahr');
    add(fromEaster(y, -2), 'Karfreitag');
    add(fromEaster(y, 1), 'Ostermontag');
    add({ y, m: 5, d: 1 }, 'Tag der Arbeit');
    add(fromEaster(y, 39), 'Christi Himmelfahrt');
    add(fromEaster(y, 50), 'Pfingstmontag');
    add({ y, m: 10, d: 3 }, 'Tag der Deutschen Einheit');
    add({ y, m: 12, d: 25 }, 'Erster Weihnachtstag');
    add({ y, m: 12, d: 26 }, 'Zweiter Weihnachtstag');
    return out;
}

/** France: the eleven jours fériés the service-public lists. */
function fr(y) {
    const out = [];
    const add = (dt, name) => out.push({ ...dt, name });
    add({ y, m: 1, d: 1 }, "Jour de l'an");
    add(fromEaster(y, 1), 'Lundi de Pâques');
    add({ y, m: 5, d: 1 }, 'Fête du Travail');
    add({ y, m: 5, d: 8 }, 'Victoire 1945');
    add(fromEaster(y, 39), 'Ascension');
    add(fromEaster(y, 50), 'Lundi de Pentecôte');
    add({ y, m: 7, d: 14 }, 'Fête Nationale');
    add({ y, m: 8, d: 15 }, 'Assomption');
    add({ y, m: 11, d: 1 }, 'Toussaint');
    add({ y, m: 11, d: 11 }, 'Armistice');
    add({ y, m: 12, d: 25 }, 'Noël');
    return out;
}

/** Spain: the national holidays (Real Decreto 2001/1983, art. 45); a holiday on a Sunday is taken Monday. */
function es(y) {
    const out = [];
    const add = (dt, name) => out.push({ ...dt, name });
    const monday = (dt) => (dow(dt.y, dt.m, dt.d) === 0 ? addDays(dt.y, dt.m, dt.d, 1) : dt);
    add(monday({ y, m: 1, d: 1 }), 'Año Nuevo');
    add(monday({ y, m: 1, d: 6 }), 'Epifanía del Señor');
    add(monday({ y, m: 3, d: 25 }), 'San José');
    if (y >= 2024) add(monday(fromEaster(y, -2)), 'Viernes Santo');
    add(monday({ y, m: 5, d: 1 }), 'Fiesta del Trabajo');
    add(monday({ y, m: 8, d: 15 }), 'Asunción de la Virgen');
    add(monday({ y, m: 10, d: 12 }), 'Fiesta Nacional de España');
    add(monday({ y, m: 11, d: 1 }), 'Todos los Santos');
    add(monday({ y, m: 12, d: 6 }), 'Día de la Constitución Española');
    add(monday({ y, m: 12, d: 8 }), 'Immaculada Concepción');
    add(monday({ y, m: 12, d: 25 }), 'Natividad del Señor');
    return out;
}

/** Italy: the national holidays (legge 260/1949, as the Ministry of Labour lists them). */
function it(y) {
    const out = [];
    const add = (dt, name) => out.push({ ...dt, name });
    add(fromEaster(y, 0), 'Pasqua');
    add(fromEaster(y, 1), "Lunedì dell'Angelo");
    add({ y, m: 5, d: 1 }, 'Festa del Lavoro');
    add({ y, m: 8, d: 15 }, 'Ferragosto');
    add({ y, m: 11, d: 1 }, 'Ognissanti');
    add({ y, m: 12, d: 8 }, 'Immacolata Concezione');
    add({ y, m: 12, d: 25 }, 'Natale');
    add({ y, m: 12, d: 26 }, 'Santo Stefano');
    return out;
}

/** The Netherlands: the national holidays the Arbeidstijdenwet names (art. 2). */
function nl(y) {
    const out = [];
    const add = (dt, name) => out.push({ ...dt, name });
    add({ y, m: 1, d: 1 }, 'Nieuwjaarsdag');
    add(fromEaster(y, -2), 'Goede Vrijdag');
    add(fromEaster(y, 0), 'Eerste Paasdag');
    add(fromEaster(y, 1), 'Tweede Paasdag');
    // King's Day is 27 April when 30 April is a Sunday.
    if (dow(y, 4, 30) === 0) add({ y, m: 4, d: 27 }, 'Koningsdag');
    else add({ y, m: 4, d: 30 }, 'Koningsdag');
    add({ y, m: 5, d: 5 }, 'Bevrijdingsdag');
    add({ y, m: 12, d: 25 }, 'Eerste Kerstdag');
    add({ y, m: 12, d: 26 }, 'Tweede Kerstdag');
    return out;
}

/** Brazil: the national holidays (Lei 662/1949 and Lei 10.607/2002). */
function br(y) {
    const out = [];
    const add = (dt, name) => out.push({ ...dt, name });
    add({ y, m: 1, d: 1 }, 'Confraternização Universal');
    add(fromEaster(y, -47), 'Carnaval');
    add(fromEaster(y, -48), 'Carnaval');
    add(fromEaster(y, -2), 'Sexta-feira Santa');
    add({ y, m: 4, d: 21 }, 'Tiradentes');
    add({ y, m: 5, d: 1 }, 'Dia do Trabalho');
    add(fromEaster(y, 60), 'Corpus Christi');
    add({ y, m: 9, d: 7 }, 'Independência do Brasil');
    add({ y, m: 10, d: 12 }, 'Nossa Senhora Aparecida');
    add({ y, m: 11, d: 2 }, 'Finados');
    add({ y, m: 11, d: 15 }, 'Proclamação da República');
    if (y >= 2024) add({ y, m: 11, d: 20 }, 'Dia da Consciência Negra');
    add({ y, m: 12, d: 25 }, 'Natal');
    return out;
}

/** Mexico: the días de descanso obligatorio of the Ley Federal del Trabajo, art. 74. */
function mx(y) {
    const out = [];
    const add = (dt, name) => out.push({ ...dt, name });
    add({ y, m: 1, d: 1 }, 'Año Nuevo');
    add(nthWeekday(y, 2, 1, 1), 'Día de la Constitución');
    add(nthWeekday(y, 3, 1, 3), 'Aniversario de Benito Juárez');
    add({ y, m: 5, d: 1 }, 'Día del Trabajo');
    add({ y, m: 9, d: 16 }, 'Día de la Independencia');
    if (y >= 2024 && (y - 2024) % 6 === 0) add({ y, m: 10, d: 1 }, 'Transmisión del Poder Ejecutivo Federal');
    add({ y, m: 11, d: 2 }, 'Día de Muertos');
    add(nthWeekday(y, 11, 1, 3), 'Día de la Revolución');
    add({ y, m: 12, d: 25 }, 'Navidad');
    return out;
}

/** India: the three holidays the gazette names nationally. */
function in_(y) {
    return [
        { y, m: 1, d: 26, name: 'Republic Day' },
        { y, m: 8, d: 15, name: 'Independence Day' },
        { y, m: 10, d: 2, name: 'Gandhi Jayanti' },
    ];
}

/**
 * The equinox day, as the National Astronomical Observatory of Japan works it out: the day of the
 * vernal (or autumnal) equinox, 1980–2099.
 */
function equinox(y, which) {
    const base = which === 'spring' ? 20.8431 : 23.2488;
    const n = y - 1980;
    const day = Math.floor(base + 0.242194 * n - Math.floor(n / 4));
    if (y < 1980) return day + 1;
    if (y > 2099) return day - 1;
    return day;
}

/**
 * Japan: the national holidays (Cabinet Office). A holiday on a Sunday is taken the next free day
 * (振替休日). The one-off moves of 2019 (the Silver Week), 2020 and 2021 (the Olympic games) are not
 * modelled: the standing rules are.
 */
function jp(y) {
    const out = [];
    const add = (dt, name) => out.push({ ...dt, name });
    add({ y, m: 1, d: 1 }, '元日');
    add(nthWeekday(y, 1, 1, 3), '成人の日');
    add({ y, m: 2, d: 11 }, '建国記念の日');
    if (y >= 2020) add({ y, m: 2, d: 23 }, '天皇誕生日');
    else add({ y, m: 12, d: 23 }, '天皇誕生日');
    add({ y, m: 3, d: equinox(y, 'spring') }, '春分の日');
    add({ y, m: 4, d: 29 }, '昭和の日');
    add({ y, m: 5, d: 3 }, '憲法記念日');
    add({ y, m: 5, d: 4 }, 'みどりの日');
    add({ y, m: 5, d: 5 }, 'こどもの日');
    add(nthWeekday(y, 7, 1, 3), '海の日');
    add({ y, m: 8, d: 11 }, '山の日');
    add(nthWeekday(y, 9, 1, 3), '敬老の日');
    add({ y, m: 9, d: equinox(y, 'autumn') }, '秋分の日');
    add(nthWeekday(y, 10, 1, 2), 'スポーツの日');
    add({ y, m: 11, d: 3 }, '文化の日');
    add({ y, m: 11, d: 23 }, '勤労感謝の日');
    // 振替休日: a national holiday on a Sunday is taken the next day that is not a holiday itself.
    const taken = new Set(out.map((h) => key(h)));
    for (const h of out.slice()) {
        if (dow(h.y, h.m, h.d) !== 0) continue;
        let d = addDays(h.y, h.m, h.d, 1);
        while (taken.has(key(d))) d = addDays(d.y, d.m, d.d, 1);
        taken.add(key(d));
        out.push({ ...d, name: '振替休日' });
    }
    return out;
}

/** The countries this service knows, with the names the week page shows. */
const COUNTRIES = Object.freeze([
    { code: 'US', name: 'United States' },
    { code: 'CA', name: 'Canada' },
    { code: 'GB', name: 'United Kingdom' },
    { code: 'IE', name: 'Ireland' },
    { code: 'AU', name: 'Australia' },
    { code: 'NZ', name: 'New Zealand' },
    { code: 'DE', name: 'Germany' },
    { code: 'FR', name: 'France' },
    { code: 'ES', name: 'Spain' },
    { code: 'IT', name: 'Italy' },
    { code: 'NL', name: 'Netherlands' },
    { code: 'BR', name: 'Brazil' },
    { code: 'MX', name: 'Mexico' },
    { code: 'IN', name: 'India' },
    { code: 'JP', name: 'Japan' },
]);

const RULES = { US: us, CA: ca, GB: gb, IE: ie, AU: au, NZ: nz, DE: de, FR: fr, ES: es, IT: it, NL: nl, BR: br, MX: mx, IN: in_, JP: jp };

/** The two-letter code of a country, when this service knows it. */
function countryOf(code) {
    const cc = String(code || '').trim().toUpperCase();
    return RULES[cc] ? cc : null;
}

/** The name of a country in English, when this service knows it. */
function countryName(code) {
    const cc = countryOf(code);
    return cc ? COUNTRIES.find((c) => c.code === cc).name : null;
}

/** The holidays of a country in a year, in date order: [{ date, name, country }]. */
function holidays(country, year) {
    const cc = countryOf(country);
    const y = Number(year);
    if (!cc || !Number.isInteger(y) || y < 1583 || y > 2999) return [];
    return RULES[cc](y)
        .map((h) => ({ date: key(h), name: h.name, country: cc }))
        .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/**
 * The zones that say which country a person is in. A zone the map does not know (UTC, or a zone in a
 * country this service has no list for) says nothing: the person then chooses a country, or has none.
 */
const ZONE_COUNTRIES = Object.freeze({
    'America/New_York': 'US', 'America/Chicago': 'US', 'America/Denver': 'US', 'America/Phoenix': 'US',
    'America/Los_Angeles': 'US', 'America/Anchorage': 'US', 'America/Detroit': 'US', 'Pacific/Honolulu': 'US',
    'America/Toronto': 'CA', 'America/Vancouver': 'CA', 'America/Edmonton': 'CA', 'America/Winnipeg': 'CA',
    'America/Halifax': 'CA', 'America/St_Johns': 'CA', 'America/Regina': 'CA',
    'America/Mexico_City': 'MX', 'America/Monterrey': 'MX',
    'America/Sao_Paulo': 'BR', 'America/Bahia': 'BR', 'America/Fortaleza': 'BR', 'America/Manaus': 'BR',
    'America/Argentina/Buenos_Aires': null, 'America/Bogota': null, 'America/Lima': null, 'America/Santiago': null,
    'Europe/London': 'GB', 'Europe/Dublin': 'IE', 'Europe/Berlin': 'DE', 'Europe/Paris': 'FR',
    'Europe/Madrid': 'ES', 'Europe/Rome': 'IT', 'Europe/Amsterdam': 'NL', 'Europe/Brussels': null,
    'Europe/Lisbon': null, 'Europe/Vienna': null, 'Europe/Zurich': null, 'Europe/Stockholm': null,
    'Europe/Oslo': null, 'Europe/Copenhagen': null, 'Europe/Helsinki': null, 'Europe/Warsaw': null,
    'Europe/Athens': null, 'Europe/Istanbul': null, 'Europe/Moscow': null,
    'Australia/Sydney': 'AU', 'Australia/Melbourne': 'AU', 'Australia/Brisbane': 'AU', 'Australia/Adelaide': 'AU',
    'Australia/Perth': 'AU', 'Australia/Hobart': 'AU', 'Australia/Darwin': 'AU', 'Australia/Lord_Howe': 'AU',
    'Pacific/Auckland': 'NZ', 'Pacific/Fiji': null,
    'Asia/Tokyo': 'JP', 'Asia/Kolkata': 'IN', 'Asia/Calcutta': 'IN', 'Asia/Shanghai': null,
    'Asia/Singapore': null, 'Asia/Seoul': null, 'Asia/Bangkok': null, 'Asia/Dubai': null, 'Asia/Jerusalem': null,
    'Africa/Lagos': null, 'Africa/Johannesburg': null, 'Africa/Cairo': null, 'Africa/Nairobi': null,
    'UTC': null, 'Etc/UTC': null, 'GMT': null,
});

/** The country a time zone says, when it says one this service knows. */
function countryOfZone(tz) {
    const zone = String(tz || '').trim();
    if (!zone) return null;
    if (Object.prototype.hasOwnProperty.call(ZONE_COUNTRIES, zone)) return ZONE_COUNTRIES[zone];
    return null;
}

/**
 * The person's country: the ?country= asked for, else the td_country cookie, else the country their
 * zone says. A code this service does not know is ignored (the query, the cookie and the zone alike).
 */
function resolveCountry({ query = null, cookie = null, tz = null } = {}) {
    const asked = countryOf(query);
    if (asked) return asked;
    const remembered = countryOf(cookie);
    if (remembered) return remembered;
    return countryOfZone(tz);
}

module.exports = { COUNTRIES, ZONE_COUNTRIES, holidays, countryOf, countryName, countryOfZone, resolveCountry };
