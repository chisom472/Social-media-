// Countries, currencies and money helpers shared by every selling feature.
// Money is ALWAYS stored as integer minor units (cents, kobo, pence...) next to a currency code.

// code:name:currency
const COUNTRY_DATA = `AF:Afghanistan:AFN|AL:Albania:ALL|DZ:Algeria:DZD|AD:Andorra:EUR|AO:Angola:AOA|AG:Antigua and Barbuda:XCD|AR:Argentina:ARS|AM:Armenia:AMD|AU:Australia:AUD|AT:Austria:EUR|AZ:Azerbaijan:AZN|BS:Bahamas:BSD|BH:Bahrain:BHD|BD:Bangladesh:BDT|BB:Barbados:BBD|BY:Belarus:BYN|BE:Belgium:EUR|BZ:Belize:BZD|BJ:Benin:XOF|BT:Bhutan:BTN|BO:Bolivia:BOB|BA:Bosnia and Herzegovina:BAM|BW:Botswana:BWP|BR:Brazil:BRL|BN:Brunei:BND|BG:Bulgaria:BGN|BF:Burkina Faso:XOF|BI:Burundi:BIF|KH:Cambodia:KHR|CM:Cameroon:XAF|CA:Canada:CAD|CV:Cape Verde:CVE|CF:Central African Republic:XAF|TD:Chad:XAF|CL:Chile:CLP|CN:China:CNY|CO:Colombia:COP|KM:Comoros:KMF|CG:Congo:XAF|CD:Congo (DRC):CDF|CR:Costa Rica:CRC|CI:Cote d'Ivoire:XOF|HR:Croatia:EUR|CU:Cuba:CUP|CY:Cyprus:EUR|CZ:Czechia:CZK|DK:Denmark:DKK|DJ:Djibouti:DJF|DM:Dominica:XCD|DO:Dominican Republic:DOP|EC:Ecuador:USD|EG:Egypt:EGP|SV:El Salvador:USD|GQ:Equatorial Guinea:XAF|ER:Eritrea:ERN|EE:Estonia:EUR|SZ:Eswatini:SZL|ET:Ethiopia:ETB|FJ:Fiji:FJD|FI:Finland:EUR|FR:France:EUR|GA:Gabon:XAF|GM:Gambia:GMD|GE:Georgia:GEL|DE:Germany:EUR|GH:Ghana:GHS|GR:Greece:EUR|GD:Grenada:XCD|GT:Guatemala:GTQ|GN:Guinea:GNF|GW:Guinea-Bissau:XOF|GY:Guyana:GYD|HT:Haiti:HTG|HN:Honduras:HNL|HK:Hong Kong:HKD|HU:Hungary:HUF|IS:Iceland:ISK|IN:India:INR|ID:Indonesia:IDR|IR:Iran:IRR|IQ:Iraq:IQD|IE:Ireland:EUR|IL:Israel:ILS|IT:Italy:EUR|JM:Jamaica:JMD|JP:Japan:JPY|JO:Jordan:JOD|KZ:Kazakhstan:KZT|KE:Kenya:KES|KI:Kiribati:AUD|XK:Kosovo:EUR|KW:Kuwait:KWD|KG:Kyrgyzstan:KGS|LA:Laos:LAK|LV:Latvia:EUR|LB:Lebanon:LBP|LS:Lesotho:LSL|LR:Liberia:LRD|LY:Libya:LYD|LI:Liechtenstein:CHF|LT:Lithuania:EUR|LU:Luxembourg:EUR|MO:Macao:MOP|MG:Madagascar:MGA|MW:Malawi:MWK|MY:Malaysia:MYR|MV:Maldives:MVR|ML:Mali:XOF|MT:Malta:EUR|MH:Marshall Islands:USD|MR:Mauritania:MRU|MU:Mauritius:MUR|MX:Mexico:MXN|FM:Micronesia:USD|MD:Moldova:MDL|MC:Monaco:EUR|MN:Mongolia:MNT|ME:Montenegro:EUR|MA:Morocco:MAD|MZ:Mozambique:MZN|MM:Myanmar:MMK|NA:Namibia:NAD|NR:Nauru:AUD|NP:Nepal:NPR|NL:Netherlands:EUR|NZ:New Zealand:NZD|NI:Nicaragua:NIO|NE:Niger:XOF|NG:Nigeria:NGN|KP:North Korea:KPW|MK:North Macedonia:MKD|NO:Norway:NOK|OM:Oman:OMR|PK:Pakistan:PKR|PW:Palau:USD|PS:Palestine:ILS|PA:Panama:PAB|PG:Papua New Guinea:PGK|PY:Paraguay:PYG|PE:Peru:PEN|PH:Philippines:PHP|PL:Poland:PLN|PT:Portugal:EUR|PR:Puerto Rico:USD|QA:Qatar:QAR|RO:Romania:RON|RU:Russia:RUB|RW:Rwanda:RWF|KN:Saint Kitts and Nevis:XCD|LC:Saint Lucia:XCD|VC:Saint Vincent and the Grenadines:XCD|WS:Samoa:WST|SM:San Marino:EUR|ST:Sao Tome and Principe:STN|SA:Saudi Arabia:SAR|SN:Senegal:XOF|RS:Serbia:RSD|SC:Seychelles:SCR|SL:Sierra Leone:SLE|SG:Singapore:SGD|SK:Slovakia:EUR|SI:Slovenia:EUR|SB:Solomon Islands:SBD|SO:Somalia:SOS|ZA:South Africa:ZAR|KR:South Korea:KRW|SS:South Sudan:SSP|ES:Spain:EUR|LK:Sri Lanka:LKR|SD:Sudan:SDG|SR:Suriname:SRD|SE:Sweden:SEK|CH:Switzerland:CHF|SY:Syria:SYP|TW:Taiwan:TWD|TJ:Tajikistan:TJS|TZ:Tanzania:TZS|TH:Thailand:THB|TL:Timor-Leste:USD|TG:Togo:XOF|TO:Tonga:TOP|TT:Trinidad and Tobago:TTD|TN:Tunisia:TND|TR:Turkey:TRY|TM:Turkmenistan:TMT|TV:Tuvalu:AUD|UG:Uganda:UGX|UA:Ukraine:UAH|AE:United Arab Emirates:AED|GB:United Kingdom:GBP|US:United States:USD|UY:Uruguay:UYU|UZ:Uzbekistan:UZS|VU:Vanuatu:VUV|VA:Vatican City:EUR|VE:Venezuela:VES|VN:Vietnam:VND|YE:Yemen:YER|ZM:Zambia:ZMW|ZW:Zimbabwe:USD`;

const DIAL = {};
`AF:93|AL:355|DZ:213|AD:376|AO:244|AG:1268|AR:54|AM:374|AU:61|AT:43|AZ:994|BS:1242|BH:973|BD:880|BB:1246|BY:375|BE:32|BZ:501|BJ:229|BT:975|BO:591|BA:387|BW:267|BR:55|BN:673|BG:359|BF:226|BI:257|KH:855|CM:237|CA:1|CV:238|CF:236|TD:235|CL:56|CN:86|CO:57|KM:269|CG:242|CD:243|CR:506|CI:225|HR:385|CU:53|CY:357|CZ:420|DK:45|DJ:253|DM:1767|DO:1|EC:593|EG:20|SV:503|GQ:240|ER:291|EE:372|SZ:268|ET:251|FJ:679|FI:358|FR:33|GA:241|GM:220|GE:995|DE:49|GH:233|GR:30|GD:1473|GT:502|GN:224|GW:245|GY:592|HT:509|HN:504|HK:852|HU:36|IS:354|IN:91|ID:62|IR:98|IQ:964|IE:353|IL:972|IT:39|JM:1876|JP:81|JO:962|KZ:7|KE:254|KI:686|XK:383|KW:965|KG:996|LA:856|LV:371|LB:961|LS:266|LR:231|LY:218|LI:423|LT:370|LU:352|MO:853|MG:261|MW:265|MY:60|MV:960|ML:223|MT:356|MH:692|MR:222|MU:230|MX:52|FM:691|MD:373|MC:377|MN:976|ME:382|MA:212|MZ:258|MM:95|NA:264|NR:674|NP:977|NL:31|NZ:64|NI:505|NE:227|NG:234|KP:850|MK:389|NO:47|OM:968|PK:92|PW:680|PS:970|PA:507|PG:675|PY:595|PE:51|PH:63|PL:48|PT:351|PR:1787|QA:974|RO:40|RU:7|RW:250|KN:1869|LC:1758|VC:1784|WS:685|SM:378|ST:239|SA:966|SN:221|RS:381|SC:248|SL:232|SG:65|SK:421|SI:386|SB:677|SO:252|ZA:27|KR:82|SS:211|ES:34|LK:94|SD:249|SR:597|SE:46|CH:41|SY:963|TW:886|TJ:992|TZ:255|TH:66|TL:670|TG:228|TO:676|TT:1868|TN:216|TR:90|TM:993|TV:688|UG:256|UA:380|AE:971|GB:44|US:1|UY:598|UZ:998|VU:678|VA:379|VE:58|VN:84|YE:967|ZM:260|ZW:263`.split('|').forEach(s => { const [c, d] = s.split(':'); DIAL[c] = d; });

const countries = COUNTRY_DATA.split('|').map(s => {
  const [code, name, currency] = s.split(':');
  return { code, name, currency, dial: DIAL[code] || '' };
});
const isCountry = code => countries.some(c => c.code === String(code || '').toUpperCase());

/** Cleans a phone number to E.164 (+2348012345678). Returns null if it can't be valid. */
function normPhone(input) {
  let p = String(input || '').trim().replace(/[\s().-]/g, '');
  if (!p) return null;
  if (p.startsWith('00')) p = '+' + p.slice(2);
  return /^\+[1-9]\d{6,14}$/.test(p) ? p : null;
}

// currencies with zero decimal places (amount 1 = 1 unit)
const ZERO_DECIMAL = new Set(['BIF', 'CLP', 'DJF', 'GNF', 'ISK', 'JPY', 'KMF', 'KRW', 'MGA', 'PYG', 'RWF', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF']);
// 3-decimal currencies (Kuwaiti Dinar, Bahraini Dinar, ...) are fully supported by the ledger and manual/bank/crypto flows
const THREE_DECIMAL = new Set(['BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND']);

const CURRENCY_NAMES = {
  USD: 'US Dollar', EUR: 'Euro', GBP: 'British Pound', NGN: 'Nigerian Naira', GHS: 'Ghanaian Cedi', KES: 'Kenyan Shilling', ZAR: 'South African Rand',
  UGX: 'Ugandan Shilling', TZS: 'Tanzanian Shilling', RWF: 'Rwandan Franc', XOF: 'West African CFA Franc', XAF: 'Central African CFA Franc', ZMW: 'Zambian Kwacha',
  EGP: 'Egyptian Pound', MAD: 'Moroccan Dirham', CAD: 'Canadian Dollar', AUD: 'Australian Dollar', NZD: 'New Zealand Dollar', INR: 'Indian Rupee', PKR: 'Pakistani Rupee',
  BDT: 'Bangladeshi Taka', CNY: 'Chinese Yuan', JPY: 'Japanese Yen', KRW: 'South Korean Won', SGD: 'Singapore Dollar', HKD: 'Hong Kong Dollar', MYR: 'Malaysian Ringgit',
  IDR: 'Indonesian Rupiah', PHP: 'Philippine Peso', THB: 'Thai Baht', VND: 'Vietnamese Dong', AED: 'UAE Dirham', SAR: 'Saudi Riyal', QAR: 'Qatari Riyal', ILS: 'Israeli Shekel',
  TRY: 'Turkish Lira', RUB: 'Russian Ruble', UAH: 'Ukrainian Hryvnia', PLN: 'Polish Zloty', CZK: 'Czech Koruna', HUF: 'Hungarian Forint', RON: 'Romanian Leu',
  SEK: 'Swedish Krona', NOK: 'Norwegian Krone', DKK: 'Danish Krone', CHF: 'Swiss Franc', BRL: 'Brazilian Real', MXN: 'Mexican Peso', ARS: 'Argentine Peso',
  CLP: 'Chilean Peso', COP: 'Colombian Peso', PEN: 'Peruvian Sol', ETB: 'Ethiopian Birr', MWK: 'Malawian Kwacha', MZN: 'Mozambican Metical', BWP: 'Botswana Pula',
  NAD: 'Namibian Dollar', MUR: 'Mauritian Rupee', SLE: 'Sierra Leonean Leone', GMD: 'Gambian Dalasi', LRD: 'Liberian Dollar', DZD: 'Algerian Dinar', LKR: 'Sri Lankan Rupee',
  NPR: 'Nepalese Rupee', KZT: 'Kazakhstani Tenge', JMD: 'Jamaican Dollar', TTD: 'Trinidad & Tobago Dollar', DOP: 'Dominican Peso', GTQ: 'Guatemalan Quetzal', CRC: 'Costa Rican Colon', KWD: 'Kuwaiti Dinar', BHD: 'Bahraini Dinar', OMR: 'Omani Rial', JOD: 'Jordanian Dinar', TND: 'Tunisian Dinar', LYD: 'Libyan Dinar', IQD: 'Iraqi Dinar'
};

const currencyCodes = [...new Set(countries.map(c => c.currency))].sort();
const decimals = cur => { const c = String(cur).toUpperCase(); return ZERO_DECIMAL.has(c) ? 0 : THREE_DECIMAL.has(c) ? 3 : 2; };
const currencies = currencyCodes.map(code => ({ code, name: CURRENCY_NAMES[code] || code, decimals: decimals(code) }));
const isCurrency = cur => currencyCodes.includes(String(cur || '').toUpperCase());
const factor = cur => Math.pow(10, decimals(cur));
/** "12.5" in USD -> 1250 */
const toMinor = (amount, cur) => Math.round(parseFloat(amount) * factor(cur)) || 0;
/** 1250 in USD -> 12.5 */
const toMajor = (minor, cur) => (Number(minor) || 0) / factor(cur);
const format = (minor, cur) => {
  try { return new Intl.NumberFormat('en', { style: 'currency', currency: cur, minimumFractionDigits: decimals(cur), maximumFractionDigits: decimals(cur) }).format(toMajor(minor, cur)); }
  catch (e) { return toMajor(minor, cur) + ' ' + cur; }
};
// Coins offered for crypto payouts (sellers can also type any other coin/network)
const CRYPTO = [
  { coin: 'BTC', name: 'Bitcoin', networks: ['Bitcoin', 'Lightning'] },
  { coin: 'ETH', name: 'Ethereum', networks: ['Ethereum (ERC-20)', 'Arbitrum', 'Optimism', 'Base'] },
  { coin: 'USDT', name: 'Tether', networks: ['Tron (TRC-20)', 'Ethereum (ERC-20)', 'BNB Chain (BEP-20)', 'Solana', 'Polygon', 'TON'] },
  { coin: 'USDC', name: 'USD Coin', networks: ['Ethereum (ERC-20)', 'Solana', 'Base', 'Polygon', 'BNB Chain (BEP-20)', 'Tron (TRC-20)'] },
  { coin: 'BNB', name: 'BNB', networks: ['BNB Chain (BEP-20)'] },
  { coin: 'SOL', name: 'Solana', networks: ['Solana'] },
  { coin: 'XRP', name: 'XRP', networks: ['XRP Ledger'] },
  { coin: 'LTC', name: 'Litecoin', networks: ['Litecoin'] },
  { coin: 'DOGE', name: 'Dogecoin', networks: ['Dogecoin'] },
  { coin: 'TRX', name: 'TRON', networks: ['Tron (TRC-20)'] },
  { coin: 'TON', name: 'Toncoin', networks: ['TON'] },
  { coin: 'MATIC', name: 'Polygon', networks: ['Polygon'] },
  { coin: 'ADA', name: 'Cardano', networks: ['Cardano'] },
  { coin: 'DAI', name: 'Dai', networks: ['Ethereum (ERC-20)'] },
  { coin: 'BCH', name: 'Bitcoin Cash', networks: ['Bitcoin Cash'] },
  { coin: 'XMR', name: 'Monero', networks: ['Monero'] }
];


// Fallback list of Nigerian banks and payment apps (used when no payment provider can supply a live list)
const NG_BANKS = [
  // commercial banks
  ['Access Bank', '044'], ['Citibank Nigeria', '023'], ['Ecobank Nigeria', '050'], ['Fidelity Bank', '070'], ['First Bank of Nigeria', '011'],
  ['First City Monument Bank (FCMB)', '214'], ['Globus Bank', '103'], ['Guaranty Trust Bank (GTBank)', '058'], ['Heritage Bank', '030'], ['Jaiz Bank', '301'],
  ['Keystone Bank', '082'], ['Parallex Bank', '104'], ['Polaris Bank', '076'], ['Providus Bank', '101'], ['Stanbic IBTC Bank', '221'],
  ['Standard Chartered Bank', '068'], ['Sterling Bank', '232'], ['SunTrust Bank', '100'], ['Titan Trust Bank', '102'], ['Union Bank of Nigeria', '032'],
  ['United Bank for Africa (UBA)', '033'], ['Unity Bank', '215'], ['Wema Bank', '035'], ['Zenith Bank', '057'],
  // Nigerian fintech apps and digital banks (when Paystack is connected the live list from Paystack replaces this one) (each has a normal 10-digit account number, often the phone number without the first 0)
  ['OPay', '999992'], ['PalmPay', '999991'], ['Kuda Microfinance Bank', '50211'], ['Moniepoint Microfinance Bank', '50515'], ['Carbon', '565'],
  ['FairMoney Microfinance Bank', '51318'], ['VFD Microfinance Bank (VBank)', '566'], ['Sparkle Microfinance Bank', '51310'], ['Rubies Microfinance Bank', '125'],
  ['Eyowo', '50126'], ['Mint Finex MFB', '50304'], ['Paga', '100002'], ['Fina Trust Microfinance Bank', '501'], ['Lagos Building Investment Company (LBIC)', '90052'],
  ['ALAT by WEMA', '035A'], ['9 Payment Service Bank (9PSB)', '120001'],
  ['MoMo PSB (MTN)', '120003'], ['Airtel SmartCash PSB', '120004'], ['Hope PSB', '120002'], ['TeasyMobile', '90115'], ['Cellulant', '100005'], ['Flutterwave Technology Solutions', '110002']
].map(([name, code]) => ({ name, code }));

// Kuwaiti banks (name, SWIFT/BIC). Kuwaiti accounts are identified by IBAN (KW + 28 characters).
const KW_BANKS = [
  ['National Bank of Kuwait (NBK)', 'NBOKKWKW'], ['Kuwait Finance House (KFH)', 'KFHOKWKW'], ['Gulf Bank', 'GULBKWKW'], ['Commercial Bank of Kuwait (CBK)', 'COMBKWKW'],
  ['Burgan Bank', 'BRGNKWKW'], ['Al Ahli Bank of Kuwait (ABK)', 'ABKKKWKW'], ['Boubyan Bank', 'BOUKKWKW'], ['Warba Bank', 'WRBAKWKW'], ['Kuwait International Bank (KIB)', 'KIBKKWKW']
].map(([name, code]) => ({ name, code }));
/** IBAN checksum (ISO 13616 mod-97). */
function validIban(iban) {
  const s = String(iban || '').replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(s)) return false;
  const r = (s.slice(4) + s.slice(0, 4)).replace(/[A-Z]/g, c => c.charCodeAt(0) - 55);
  let rem = 0; for (const ch of r) rem = (rem * 10 + Number(ch)) % 97;
  return rem === 1;
}
const normCurrency = (c, fallback) => (isCurrency(c) ? String(c).toUpperCase() : fallback);

module.exports = { KW_BANKS, validIban, NG_BANKS, CRYPTO, countries, isCountry, normPhone, currencies, decimals, isCurrency, toMinor, toMajor, format, normCurrency, factor };
