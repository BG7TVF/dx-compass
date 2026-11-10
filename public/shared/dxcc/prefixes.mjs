/**
 * DXCC 呼号前缀表（前后端共用，静态数据）。
 *
 * 来源：ARRL DXCC List 2026-01 edition，经 k0swe/dxcc-json 的 dxcc-2026-01.csv 提取 prefix 列
 *       （https://github.com/k0swe/dxcc-json）；DXCC 编号与 ARRL 现行实体表核对。
 * 抓取日期：2026-11-11。
 * 说明：一个实体一行，prefix 为展示用主字头，prefixes 为 ARRL 列出的呼号区前缀。
 *       3D2 / KH8 / FT5 等共享前缀由 callsign.mjs 的后缀规则区分，未命中时取编号最小的实体。
 */

export const PREFIX_SOURCE = "ARRL DXCC List 2026-01 via k0swe/dxcc-json dxcc-2026-01.csv (fetched 2026-11-11)";

export const PREFIX_ENTRIES = [
    {
        "dxcc": 1,
        "name": "Canada",
        "prefix": "VE",
        "prefixes": [
            "VA",
            "VB",
            "VC",
            "VD",
            "VE",
            "VF",
            "VG",
            "VO",
            "VY"
        ],
        "deleted": false
    },
    {
        "dxcc": 3,
        "name": "Afghanistan",
        "prefix": "YA",
        "prefixes": [
            "YA",
            "T6"
        ],
        "deleted": false
    },
    {
        "dxcc": 4,
        "name": "Agaléga and Saint Brandon",
        "prefix": "3B6",
        "prefixes": [
            "3B6",
            "3B7"
        ],
        "deleted": false
    },
    {
        "dxcc": 5,
        "name": "Åland Islands",
        "prefix": "OH0",
        "prefixes": [
            "OH0"
        ],
        "deleted": false
    },
    {
        "dxcc": 6,
        "name": "Alaska",
        "prefix": "KL",
        "prefixes": [
            "KL",
            "AL",
            "NL",
            "WL"
        ],
        "deleted": false
    },
    {
        "dxcc": 7,
        "name": "Albania",
        "prefix": "ZA",
        "prefixes": [
            "ZA"
        ],
        "deleted": false
    },
    {
        "dxcc": 8,
        "name": "Aldabra",
        "prefix": "VQ9",
        "prefixes": [
            "VQ9"
        ],
        "deleted": true
    },
    {
        "dxcc": 9,
        "name": "American Samoa",
        "prefix": "KH8",
        "prefixes": [
            "KH8"
        ],
        "deleted": false
    },
    {
        "dxcc": 10,
        "name": "Amsterdam and Saint-Paul Islands",
        "prefix": "FT5Z",
        "prefixes": [
            "FT/Z",
            "FT5Z"
        ],
        "deleted": false
    },
    {
        "dxcc": 11,
        "name": "Andaman and Nicobar Islands",
        "prefix": "VU4",
        "prefixes": [
            "VU4"
        ],
        "deleted": false
    },
    {
        "dxcc": 12,
        "name": "Anguilla",
        "prefix": "VP2E",
        "prefixes": [
            "VP2E"
        ],
        "deleted": false
    },
    {
        "dxcc": 13,
        "name": "Antarctica",
        "prefix": "CE9",
        "prefixes": [
            "CE9",
            "KC4"
        ],
        "deleted": false
    },
    {
        "dxcc": 14,
        "name": "Armenia",
        "prefix": "EK",
        "prefixes": [
            "EK"
        ],
        "deleted": false
    },
    {
        "dxcc": 15,
        "name": "Asiatic Russia",
        "prefix": "UA9",
        "prefixes": [
            "UA0",
            "UA8",
            "UA9",
            "UB0",
            "UB8",
            "UB9",
            "UC0",
            "UC8",
            "UC9",
            "UD0",
            "UD8",
            "UD9",
            "UE0",
            "UE8",
            "UE9",
            "UF0",
            "UF8",
            "UF9",
            "UG0",
            "UG8",
            "UG9",
            "UH0",
            "UH8",
            "UH9",
            "UI0",
            "UI8",
            "UI9",
            "RA",
            "RB",
            "RC",
            "RD",
            "RE",
            "RF",
            "RG",
            "RH",
            "RI",
            "RJ",
            "RK",
            "RL",
            "RM",
            "RN",
            "RO",
            "RP",
            "RQ",
            "RR",
            "RS",
            "RT",
            "RU",
            "RV",
            "RW",
            "RX",
            "RY",
            "RZ"
        ],
        "deleted": false
    },
    {
        "dxcc": 16,
        "name": "New Zealand Subantarctic Islands",
        "prefix": "ZL9",
        "prefixes": [
            "ZL9"
        ],
        "deleted": false
    },
    {
        "dxcc": 17,
        "name": "Isla de Aves",
        "prefix": "YV0",
        "prefixes": [
            "YV0"
        ],
        "deleted": false
    },
    {
        "dxcc": 18,
        "name": "Azerbaijan",
        "prefix": "4J",
        "prefixes": [
            "4J",
            "4K"
        ],
        "deleted": false
    },
    {
        "dxcc": 19,
        "name": "Bajo Nuevo",
        "prefix": "HK0",
        "prefixes": [
            "HK0"
        ],
        "deleted": true
    },
    {
        "dxcc": 20,
        "name": "Baker and Howland Islands",
        "prefix": "KH1",
        "prefixes": [
            "KH1"
        ],
        "deleted": false
    },
    {
        "dxcc": 21,
        "name": "Balearic Islands",
        "prefix": "EA6",
        "prefixes": [
            "EA6",
            "EB6",
            "EC6",
            "ED6",
            "EE6",
            "EF6",
            "EG6",
            "EH6"
        ],
        "deleted": false
    },
    {
        "dxcc": 22,
        "name": "Palau",
        "prefix": "T8",
        "prefixes": [
            "T8"
        ],
        "deleted": false
    },
    {
        "dxcc": 24,
        "name": "Bouvet Island",
        "prefix": "3Y/B",
        "prefixes": [
            "3Y",
            "3Y/B"
        ],
        "deleted": false
    },
    {
        "dxcc": 25,
        "name": "British North Borneo",
        "prefix": "ZC5",
        "prefixes": [
            "ZC5"
        ],
        "deleted": true
    },
    {
        "dxcc": 26,
        "name": "British Somaliland",
        "prefix": "VQ6",
        "prefixes": [
            "VQ6"
        ],
        "deleted": true
    },
    {
        "dxcc": 27,
        "name": "Belarus",
        "prefix": "EU",
        "prefixes": [
            "EU",
            "EV",
            "EW"
        ],
        "deleted": false
    },
    {
        "dxcc": 28,
        "name": "Panama Canal Zone",
        "prefix": "KZ5",
        "prefixes": [
            "KZ5"
        ],
        "deleted": true
    },
    {
        "dxcc": 29,
        "name": "Canary Islands",
        "prefix": "EA8",
        "prefixes": [
            "EA8",
            "EB8",
            "EC8",
            "ED8",
            "EE8",
            "EF8",
            "EG8",
            "EH8"
        ],
        "deleted": false
    },
    {
        "dxcc": 30,
        "name": "Celebes and the Molucca Islands",
        "prefix": "PK6",
        "prefixes": [
            "PK6"
        ],
        "deleted": true
    },
    {
        "dxcc": 31,
        "name": "Phoenix Islands",
        "prefix": "T31",
        "prefixes": [
            "T31"
        ],
        "deleted": false
    },
    {
        "dxcc": 32,
        "name": "Ceuta and Melilla",
        "prefix": "EA9",
        "prefixes": [
            "EA9",
            "EB9",
            "EC9",
            "ED9",
            "EE9",
            "EF9",
            "EG9",
            "EH9"
        ],
        "deleted": false
    },
    {
        "dxcc": 33,
        "name": "Chagos Islands",
        "prefix": "VQ9",
        "prefixes": [
            "VQ9"
        ],
        "deleted": false
    },
    {
        "dxcc": 34,
        "name": "Chatham Islands",
        "prefix": "ZL7",
        "prefixes": [
            "ZL7"
        ],
        "deleted": false
    },
    {
        "dxcc": 35,
        "name": "Christmas Island",
        "prefix": "VK9X",
        "prefixes": [
            "VK9X"
        ],
        "deleted": false
    },
    {
        "dxcc": 36,
        "name": "Clipperton Island",
        "prefix": "FO/C",
        "prefixes": [
            "FO",
            "TX",
            "FO/C"
        ],
        "deleted": false
    },
    {
        "dxcc": 37,
        "name": "Cocos Island",
        "prefix": "TI9",
        "prefixes": [
            "TI9"
        ],
        "deleted": false
    },
    {
        "dxcc": 38,
        "name": "Cocos (Keeling) Islands",
        "prefix": "VK9C",
        "prefixes": [
            "VK9C"
        ],
        "deleted": false
    },
    {
        "dxcc": 39,
        "name": "Comoros",
        "prefix": "D6",
        "prefixes": [
            "FH",
            "FB8",
            "D6"
        ],
        "deleted": true
    },
    {
        "dxcc": 40,
        "name": "Crete",
        "prefix": "SV9",
        "prefixes": [
            "SV9",
            "J49"
        ],
        "deleted": false
    },
    {
        "dxcc": 41,
        "name": "Crozet Islands",
        "prefix": "FT5W",
        "prefixes": [
            "FT/W",
            "FT5W"
        ],
        "deleted": false
    },
    {
        "dxcc": 42,
        "name": "Daman and Diu",
        "prefix": "CR8",
        "prefixes": [
            "CR8"
        ],
        "deleted": true
    },
    {
        "dxcc": 43,
        "name": "Desecheo Island",
        "prefix": "KP5",
        "prefixes": [
            "KP5"
        ],
        "deleted": false
    },
    {
        "dxcc": 44,
        "name": "Desroches Island",
        "prefix": "VQ9",
        "prefixes": [
            "VQ9"
        ],
        "deleted": true
    },
    {
        "dxcc": 45,
        "name": "Dodecanese",
        "prefix": "SV5",
        "prefixes": [
            "SV5",
            "J45"
        ],
        "deleted": false
    },
    {
        "dxcc": 46,
        "name": "East Malaysia",
        "prefix": "9M6",
        "prefixes": [
            "9M6",
            "9M8"
        ],
        "deleted": false
    },
    {
        "dxcc": 47,
        "name": "Easter Island",
        "prefix": "CE0Y",
        "prefixes": [
            "CE0",
            "CE0Y"
        ],
        "deleted": false
    },
    {
        "dxcc": 48,
        "name": "Line Islands",
        "prefix": "T32",
        "prefixes": [
            "T32"
        ],
        "deleted": false
    },
    {
        "dxcc": 49,
        "name": "Equatorial Guinea",
        "prefix": "3C",
        "prefixes": [
            "3C"
        ],
        "deleted": false
    },
    {
        "dxcc": 50,
        "name": "Mexico",
        "prefix": "XE",
        "prefixes": [
            "XA",
            "XB",
            "XC",
            "XD",
            "XE",
            "XF",
            "XG",
            "XH",
            "XI"
        ],
        "deleted": false
    },
    {
        "dxcc": 51,
        "name": "Eritrea",
        "prefix": "E3",
        "prefixes": [
            "E3"
        ],
        "deleted": false
    },
    {
        "dxcc": 52,
        "name": "Estonia",
        "prefix": "ES",
        "prefixes": [
            "ES"
        ],
        "deleted": false
    },
    {
        "dxcc": 53,
        "name": "Ethiopia",
        "prefix": "ET",
        "prefixes": [
            "ET"
        ],
        "deleted": false
    },
    {
        "dxcc": 54,
        "name": "European Russia",
        "prefix": "UA",
        "prefixes": [
            "UA1",
            "UA2",
            "UA3",
            "UA4",
            "UA5",
            "UA6",
            "UA7",
            "UB1",
            "UB2",
            "UB3",
            "UB4",
            "UB5",
            "UB6",
            "UB7",
            "UC1",
            "UC2",
            "UC3",
            "UC4",
            "UC5",
            "UC6",
            "UC7",
            "UD1",
            "UD2",
            "UD3",
            "UD4",
            "UD5",
            "UD6",
            "UD7",
            "UE1",
            "UE2",
            "UE3",
            "UE4",
            "UE5",
            "UE6",
            "UE7",
            "UF1",
            "UF2",
            "UF3",
            "UF4",
            "UF5",
            "UF6",
            "UF7",
            "UG1",
            "UG2",
            "UG3",
            "UG4",
            "UG5",
            "UG6",
            "UG7",
            "UH1",
            "UH2",
            "UH3",
            "UH4",
            "UH5",
            "UH6",
            "UH7",
            "UI1",
            "UI2",
            "UI3",
            "UI4",
            "UI5",
            "UI6",
            "UI7",
            "RA",
            "RB",
            "RC",
            "RD",
            "RE",
            "RF",
            "RG",
            "RH",
            "RI",
            "RJ",
            "RK",
            "RL",
            "RM",
            "RN",
            "RO",
            "RP",
            "RQ",
            "RR",
            "RS",
            "RT",
            "RU",
            "RV",
            "RW",
            "RX",
            "RY",
            "RZ",
            "UA"
        ],
        "deleted": false
    },
    {
        "dxcc": 55,
        "name": "Farquhar Group",
        "prefix": "VQ9",
        "prefixes": [
            "VQ9"
        ],
        "deleted": true
    },
    {
        "dxcc": 56,
        "name": "Fernando de Noronha",
        "prefix": "PY0F",
        "prefixes": [
            "PP0F",
            "PQ0F",
            "PR0F",
            "PS0F",
            "PT0F",
            "PU0F",
            "PV0F",
            "PW0F",
            "PX0F",
            "PY0F"
        ],
        "deleted": false
    },
    {
        "dxcc": 57,
        "name": "French Equatorial Africa",
        "prefix": "FQ8",
        "prefixes": [
            "FQ8"
        ],
        "deleted": true
    },
    {
        "dxcc": 58,
        "name": "French Indo-China",
        "prefix": "FI8",
        "prefixes": [
            "FI8"
        ],
        "deleted": true
    },
    {
        "dxcc": 59,
        "name": "French West Africa",
        "prefix": "FF",
        "prefixes": [
            "FF"
        ],
        "deleted": true
    },
    {
        "dxcc": 60,
        "name": "Bahamas",
        "prefix": "C6",
        "prefixes": [
            "C6"
        ],
        "deleted": false
    },
    {
        "dxcc": 61,
        "name": "Franz Josef Land",
        "prefix": "R1FJ",
        "prefixes": [
            "R1/F",
            "R1FJ"
        ],
        "deleted": false
    },
    {
        "dxcc": 62,
        "name": "Barbados",
        "prefix": "8P",
        "prefixes": [
            "8P"
        ],
        "deleted": false
    },
    {
        "dxcc": 63,
        "name": "French Guiana",
        "prefix": "FY",
        "prefixes": [
            "FY"
        ],
        "deleted": false
    },
    {
        "dxcc": 64,
        "name": "Bermuda",
        "prefix": "VP9",
        "prefixes": [
            "VP9"
        ],
        "deleted": false
    },
    {
        "dxcc": 65,
        "name": "British Virgin Is.",
        "prefix": "VP2V",
        "prefixes": [
            "VP2V"
        ],
        "deleted": false
    },
    {
        "dxcc": 66,
        "name": "Belize",
        "prefix": "V3",
        "prefixes": [
            "V3"
        ],
        "deleted": false
    },
    {
        "dxcc": 67,
        "name": "French India",
        "prefix": "FN8",
        "prefixes": [
            "FN8"
        ],
        "deleted": true
    },
    {
        "dxcc": 68,
        "name": "Kuwait/Saudi Arabia Neutral Zone",
        "prefix": "8Z5",
        "prefixes": [
            "8Z5",
            "9K3"
        ],
        "deleted": true
    },
    {
        "dxcc": 69,
        "name": "Cayman Islands",
        "prefix": "ZF",
        "prefixes": [
            "ZF"
        ],
        "deleted": false
    },
    {
        "dxcc": 70,
        "name": "Cuba",
        "prefix": "CM",
        "prefixes": [
            "CL",
            "CM",
            "CO"
        ],
        "deleted": false
    },
    {
        "dxcc": 71,
        "name": "Galápagos Islands",
        "prefix": "HC8",
        "prefixes": [
            "HC8",
            "HD8"
        ],
        "deleted": false
    },
    {
        "dxcc": 72,
        "name": "Dominican Republic",
        "prefix": "HI",
        "prefixes": [
            "HI"
        ],
        "deleted": false
    },
    {
        "dxcc": 74,
        "name": "El Salvador",
        "prefix": "YS",
        "prefixes": [
            "YS",
            "HU"
        ],
        "deleted": false
    },
    {
        "dxcc": 75,
        "name": "Georgia",
        "prefix": "4L",
        "prefixes": [
            "4L"
        ],
        "deleted": false
    },
    {
        "dxcc": 76,
        "name": "Guatemala",
        "prefix": "TG",
        "prefixes": [
            "TG",
            "TD"
        ],
        "deleted": false
    },
    {
        "dxcc": 77,
        "name": "Grenada",
        "prefix": "J3",
        "prefixes": [
            "J3"
        ],
        "deleted": false
    },
    {
        "dxcc": 78,
        "name": "Haiti",
        "prefix": "HH",
        "prefixes": [
            "HH"
        ],
        "deleted": false
    },
    {
        "dxcc": 79,
        "name": "Guadeloupe",
        "prefix": "FG",
        "prefixes": [
            "FG",
            "TO"
        ],
        "deleted": false
    },
    {
        "dxcc": 80,
        "name": "Honduras",
        "prefix": "HR",
        "prefixes": [
            "HQ",
            "HR"
        ],
        "deleted": false
    },
    {
        "dxcc": 81,
        "name": "West Germany",
        "prefix": "DL",
        "prefixes": [
            "DA",
            "DB",
            "DC",
            "DD",
            "DE",
            "DF",
            "DG",
            "DH",
            "DI",
            "DJ",
            "DK",
            "DL"
        ],
        "deleted": true
    },
    {
        "dxcc": 82,
        "name": "Jamaica",
        "prefix": "6Y",
        "prefixes": [
            "6Y"
        ],
        "deleted": false
    },
    {
        "dxcc": 84,
        "name": "Martinique",
        "prefix": "FM",
        "prefixes": [
            "FM",
            "TO"
        ],
        "deleted": false
    },
    {
        "dxcc": 85,
        "name": "Bonaire and Curaçao",
        "prefix": "PJ",
        "prefixes": [
            "PJ"
        ],
        "deleted": true
    },
    {
        "dxcc": 86,
        "name": "Nicaragua",
        "prefix": "YN",
        "prefixes": [
            "YN",
            "H6",
            "H7",
            "HT"
        ],
        "deleted": false
    },
    {
        "dxcc": 88,
        "name": "Panama",
        "prefix": "HP",
        "prefixes": [
            "HO",
            "HP"
        ],
        "deleted": false
    },
    {
        "dxcc": 89,
        "name": "Turks and Caicos Islands",
        "prefix": "VP5",
        "prefixes": [
            "VP5"
        ],
        "deleted": false
    },
    {
        "dxcc": 90,
        "name": "Trinidad and Tobago",
        "prefix": "9Y",
        "prefixes": [
            "9Y",
            "9Z"
        ],
        "deleted": false
    },
    {
        "dxcc": 91,
        "name": "Aruba",
        "prefix": "P4",
        "prefixes": [
            "P4"
        ],
        "deleted": false
    },
    {
        "dxcc": 94,
        "name": "Antigua and Barbuda",
        "prefix": "V2",
        "prefixes": [
            "V2"
        ],
        "deleted": false
    },
    {
        "dxcc": 95,
        "name": "Dominica",
        "prefix": "J7",
        "prefixes": [
            "J7"
        ],
        "deleted": false
    },
    {
        "dxcc": 96,
        "name": "Montserrat",
        "prefix": "VP2M",
        "prefixes": [
            "VP2M"
        ],
        "deleted": false
    },
    {
        "dxcc": 97,
        "name": "Saint Lucia",
        "prefix": "J6",
        "prefixes": [
            "J6"
        ],
        "deleted": false
    },
    {
        "dxcc": 98,
        "name": "Saint Vincent and the Grenadines",
        "prefix": "J8",
        "prefixes": [
            "J8"
        ],
        "deleted": false
    },
    {
        "dxcc": 99,
        "name": "Glorioso Islands",
        "prefix": "FT/G",
        "prefixes": [
            "FT/G",
            "TO"
        ],
        "deleted": false
    },
    {
        "dxcc": 100,
        "name": "Argentina",
        "prefix": "LU",
        "prefixes": [
            "LO",
            "LP",
            "LQ",
            "LR",
            "LS",
            "LT",
            "LU",
            "LV",
            "LW"
        ],
        "deleted": false
    },
    {
        "dxcc": 101,
        "name": "Goa",
        "prefix": "CR8",
        "prefixes": [
            "CR8"
        ],
        "deleted": true
    },
    {
        "dxcc": 102,
        "name": "British Togoland",
        "prefix": "ZD4",
        "prefixes": [
            "ZD4"
        ],
        "deleted": true
    },
    {
        "dxcc": 103,
        "name": "Guam",
        "prefix": "KH2",
        "prefixes": [
            "KH2"
        ],
        "deleted": false
    },
    {
        "dxcc": 104,
        "name": "Bolivia",
        "prefix": "CP",
        "prefixes": [
            "CP"
        ],
        "deleted": false
    },
    {
        "dxcc": 105,
        "name": "Guantanamo Bay",
        "prefix": "KG4",
        "prefixes": [
            "KG4"
        ],
        "deleted": false
    },
    {
        "dxcc": 106,
        "name": "Guernsey",
        "prefix": "GU",
        "prefixes": [
            "GU",
            "GP"
        ],
        "deleted": false
    },
    {
        "dxcc": 107,
        "name": "Guinea",
        "prefix": "3X",
        "prefixes": [
            "3X"
        ],
        "deleted": false
    },
    {
        "dxcc": 108,
        "name": "Brazil",
        "prefix": "PY",
        "prefixes": [
            "PP",
            "PQ",
            "PR",
            "PS",
            "PT",
            "PU",
            "PV",
            "PW",
            "PX",
            "PY",
            "ZV",
            "ZW",
            "ZX",
            "ZY",
            "ZZ"
        ],
        "deleted": false
    },
    {
        "dxcc": 109,
        "name": "Guinea-Bissau",
        "prefix": "J5",
        "prefixes": [
            "J5"
        ],
        "deleted": false
    },
    {
        "dxcc": 110,
        "name": "Hawaii",
        "prefix": "KH6",
        "prefixes": [
            "KH6",
            "KH7"
        ],
        "deleted": false
    },
    {
        "dxcc": 111,
        "name": "Heard Island and McDonald Islands",
        "prefix": "VK0H",
        "prefixes": [
            "VK0",
            "VK0H"
        ],
        "deleted": false
    },
    {
        "dxcc": 112,
        "name": "Chile",
        "prefix": "CE",
        "prefixes": [
            "CA",
            "CB",
            "CC",
            "CD",
            "CE"
        ],
        "deleted": false
    },
    {
        "dxcc": 113,
        "name": "Ifni",
        "prefix": "EA9",
        "prefixes": [
            "EA9"
        ],
        "deleted": true
    },
    {
        "dxcc": 114,
        "name": "Isle of Man",
        "prefix": "GD",
        "prefixes": [
            "GD",
            "GT"
        ],
        "deleted": false
    },
    {
        "dxcc": 115,
        "name": "Italian Somaliland",
        "prefix": "I5",
        "prefixes": [
            "I5"
        ],
        "deleted": true
    },
    {
        "dxcc": 116,
        "name": "Colombia",
        "prefix": "HK",
        "prefixes": [
            "HJ",
            "HK",
            "5J",
            "5K"
        ],
        "deleted": false
    },
    {
        "dxcc": 117,
        "name": "International Telecommunication Union Headquarters",
        "prefix": "4U1I",
        "prefixes": [
            "4U",
            "4U1I"
        ],
        "deleted": false
    },
    {
        "dxcc": 118,
        "name": "Jan Mayen",
        "prefix": "JX",
        "prefixes": [
            "JX"
        ],
        "deleted": false
    },
    {
        "dxcc": 119,
        "name": "Java",
        "prefix": "PK1",
        "prefixes": [
            "PK1",
            "PK2",
            "PK3"
        ],
        "deleted": true
    },
    {
        "dxcc": 120,
        "name": "Ecuador",
        "prefix": "HC",
        "prefixes": [
            "HC",
            "HD"
        ],
        "deleted": false
    },
    {
        "dxcc": 122,
        "name": "Jersey",
        "prefix": "GJ",
        "prefixes": [
            "GJ",
            "GH"
        ],
        "deleted": false
    },
    {
        "dxcc": 123,
        "name": "Johnston Atoll",
        "prefix": "KH3",
        "prefixes": [
            "KH3"
        ],
        "deleted": false
    },
    {
        "dxcc": 124,
        "name": "Juan de Nova and Europa Islands",
        "prefix": "FT/J",
        "prefixes": [
            "FT/J",
            "FT/E",
            "TO"
        ],
        "deleted": false
    },
    {
        "dxcc": 125,
        "name": "Juan Fernández Islands",
        "prefix": "CE0Z",
        "prefixes": [
            "CE0",
            "CE0Z"
        ],
        "deleted": false
    },
    {
        "dxcc": 126,
        "name": "Kaliningrad",
        "prefix": "UA2",
        "prefixes": [
            "UA2",
            "RA2"
        ],
        "deleted": false
    },
    {
        "dxcc": 127,
        "name": "Kamaran Island",
        "prefix": "VS9K",
        "prefixes": [
            "VS9K"
        ],
        "deleted": true
    },
    {
        "dxcc": 128,
        "name": "Karelo-Finnish Soviet Socialist Republic",
        "prefix": "UN1",
        "prefixes": [
            "UN1"
        ],
        "deleted": true
    },
    {
        "dxcc": 129,
        "name": "Guyana",
        "prefix": "8R",
        "prefixes": [
            "8R"
        ],
        "deleted": false
    },
    {
        "dxcc": 130,
        "name": "Kazakhstan",
        "prefix": "UN",
        "prefixes": [
            "UN",
            "UO",
            "UP",
            "UQ"
        ],
        "deleted": false
    },
    {
        "dxcc": 131,
        "name": "Kerguelen Islands",
        "prefix": "FT5X",
        "prefixes": [
            "FT/X",
            "FT5X"
        ],
        "deleted": false
    },
    {
        "dxcc": 132,
        "name": "Paraguay",
        "prefix": "ZP",
        "prefixes": [
            "ZP"
        ],
        "deleted": false
    },
    {
        "dxcc": 133,
        "name": "Kermadec Islands",
        "prefix": "ZL8",
        "prefixes": [
            "ZL8"
        ],
        "deleted": false
    },
    {
        "dxcc": 134,
        "name": "Kingman Reef",
        "prefix": "KH5K",
        "prefixes": [
            "KH5K"
        ],
        "deleted": true
    },
    {
        "dxcc": 135,
        "name": "Kyrgyzstan",
        "prefix": "EX",
        "prefixes": [
            "EX"
        ],
        "deleted": false
    },
    {
        "dxcc": 136,
        "name": "Peru",
        "prefix": "OA",
        "prefixes": [
            "OA",
            "OB",
            "OC"
        ],
        "deleted": false
    },
    {
        "dxcc": 137,
        "name": "South Korea",
        "prefix": "HL",
        "prefixes": [
            "HL",
            "6K",
            "6L",
            "6M",
            "6N"
        ],
        "deleted": false
    },
    {
        "dxcc": 138,
        "name": "Kure Atoll",
        "prefix": "KH7K",
        "prefixes": [
            "KH7K"
        ],
        "deleted": false
    },
    {
        "dxcc": 139,
        "name": "Khuriya Muriya Islands",
        "prefix": "VS9H",
        "prefixes": [
            "VS9H"
        ],
        "deleted": true
    },
    {
        "dxcc": 140,
        "name": "Suriname",
        "prefix": "PZ",
        "prefixes": [
            "PZ"
        ],
        "deleted": false
    },
    {
        "dxcc": 141,
        "name": "Falkland Islands",
        "prefix": "VP8",
        "prefixes": [
            "VP8"
        ],
        "deleted": false
    },
    {
        "dxcc": 142,
        "name": "Lakshadweep",
        "prefix": "VU7",
        "prefixes": [
            "VU7"
        ],
        "deleted": false
    },
    {
        "dxcc": 143,
        "name": "Laos",
        "prefix": "XW",
        "prefixes": [
            "XW"
        ],
        "deleted": false
    },
    {
        "dxcc": 144,
        "name": "Uruguay",
        "prefix": "CX",
        "prefixes": [
            "CV",
            "CW",
            "CX"
        ],
        "deleted": false
    },
    {
        "dxcc": 145,
        "name": "Latvia",
        "prefix": "YL",
        "prefixes": [
            "YL"
        ],
        "deleted": false
    },
    {
        "dxcc": 146,
        "name": "Lithuania",
        "prefix": "LY",
        "prefixes": [
            "LY"
        ],
        "deleted": false
    },
    {
        "dxcc": 147,
        "name": "Lord Howe Island",
        "prefix": "VK9L",
        "prefixes": [
            "VK9L"
        ],
        "deleted": false
    },
    {
        "dxcc": 148,
        "name": "Venezuela",
        "prefix": "YV",
        "prefixes": [
            "YV",
            "YW",
            "YX",
            "YY",
            "4M"
        ],
        "deleted": false
    },
    {
        "dxcc": 149,
        "name": "Azores",
        "prefix": "CU",
        "prefixes": [
            "CU"
        ],
        "deleted": false
    },
    {
        "dxcc": 150,
        "name": "Australia",
        "prefix": "VK",
        "prefixes": [
            "VK",
            "AX"
        ],
        "deleted": false
    },
    {
        "dxcc": 151,
        "name": "Maly Vysotsky Island",
        "prefix": "R1/M",
        "prefixes": [
            "R1/M"
        ],
        "deleted": true
    },
    {
        "dxcc": 152,
        "name": "Macao",
        "prefix": "XX9",
        "prefixes": [
            "XX9"
        ],
        "deleted": false
    },
    {
        "dxcc": 153,
        "name": "Macquarie Island",
        "prefix": "VK0M",
        "prefixes": [
            "VK0",
            "VK7",
            "VK0M"
        ],
        "deleted": false
    },
    {
        "dxcc": 154,
        "name": "Yemen Arab Republic",
        "prefix": "4W",
        "prefixes": [
            "4W"
        ],
        "deleted": true
    },
    {
        "dxcc": 155,
        "name": "Malaya",
        "prefix": "VS2",
        "prefixes": [
            "VS2",
            "9M2"
        ],
        "deleted": true
    },
    {
        "dxcc": 157,
        "name": "Nauru",
        "prefix": "C2",
        "prefixes": [
            "C2"
        ],
        "deleted": false
    },
    {
        "dxcc": 158,
        "name": "Vanuatu",
        "prefix": "YJ",
        "prefixes": [
            "YJ"
        ],
        "deleted": false
    },
    {
        "dxcc": 159,
        "name": "Maldives",
        "prefix": "8Q",
        "prefixes": [
            "8Q"
        ],
        "deleted": false
    },
    {
        "dxcc": 160,
        "name": "Tonga",
        "prefix": "A3",
        "prefixes": [
            "A3"
        ],
        "deleted": false
    },
    {
        "dxcc": 161,
        "name": "Malpelo Island",
        "prefix": "HK0/M",
        "prefixes": [
            "HK0",
            "HK0/M"
        ],
        "deleted": false
    },
    {
        "dxcc": 162,
        "name": "New Caledonia",
        "prefix": "FK",
        "prefixes": [
            "FK",
            "TX"
        ],
        "deleted": false
    },
    {
        "dxcc": 163,
        "name": "Papua New Guinea",
        "prefix": "P2",
        "prefixes": [
            "P2"
        ],
        "deleted": false
    },
    {
        "dxcc": 164,
        "name": "Manchuria",
        "prefix": "C9",
        "prefixes": [
            "C9"
        ],
        "deleted": true
    },
    {
        "dxcc": 165,
        "name": "Mauritius",
        "prefix": "3B8",
        "prefixes": [
            "3B8"
        ],
        "deleted": false
    },
    {
        "dxcc": 166,
        "name": "Mariana Islands",
        "prefix": "KH0",
        "prefixes": [
            "KH0"
        ],
        "deleted": false
    },
    {
        "dxcc": 167,
        "name": "Märket Island",
        "prefix": "OJ0",
        "prefixes": [
            "OJ0"
        ],
        "deleted": false
    },
    {
        "dxcc": 168,
        "name": "Marshall Islands",
        "prefix": "V7",
        "prefixes": [
            "V7"
        ],
        "deleted": false
    },
    {
        "dxcc": 169,
        "name": "Mayotte",
        "prefix": "FH",
        "prefixes": [
            "FH",
            "TO"
        ],
        "deleted": false
    },
    {
        "dxcc": 170,
        "name": "New Zealand",
        "prefix": "ZL",
        "prefixes": [
            "ZK",
            "ZL",
            "ZM"
        ],
        "deleted": false
    },
    {
        "dxcc": 171,
        "name": "Mellish Reef",
        "prefix": "VK9M",
        "prefixes": [
            "VK9M"
        ],
        "deleted": false
    },
    {
        "dxcc": 172,
        "name": "Pitcairn Islands",
        "prefix": "VP6",
        "prefixes": [
            "VP6"
        ],
        "deleted": false
    },
    {
        "dxcc": 173,
        "name": "Micronesia",
        "prefix": "V6",
        "prefixes": [
            "V6"
        ],
        "deleted": false
    },
    {
        "dxcc": 174,
        "name": "Midway Atoll",
        "prefix": "KH4",
        "prefixes": [
            "KH4"
        ],
        "deleted": false
    },
    {
        "dxcc": 175,
        "name": "French Polynesia",
        "prefix": "FO",
        "prefixes": [
            "FO",
            "TX"
        ],
        "deleted": false
    },
    {
        "dxcc": 176,
        "name": "Fiji",
        "prefix": "3D2",
        "prefixes": [
            "3D2"
        ],
        "deleted": false
    },
    {
        "dxcc": 177,
        "name": "Minami-Tori-shima",
        "prefix": "JD/M",
        "prefixes": [
            "JD1",
            "JD/M"
        ],
        "deleted": false
    },
    {
        "dxcc": 178,
        "name": "Minerva Reefs",
        "prefix": "1M",
        "prefixes": [
            "1M"
        ],
        "deleted": true
    },
    {
        "dxcc": 179,
        "name": "Moldova",
        "prefix": "ER",
        "prefixes": [
            "ER"
        ],
        "deleted": false
    },
    {
        "dxcc": 180,
        "name": "Mount Athos",
        "prefix": "SV/A",
        "prefixes": [
            "SV/A"
        ],
        "deleted": false
    },
    {
        "dxcc": 181,
        "name": "Mozambique",
        "prefix": "C9",
        "prefixes": [
            "C8",
            "C9"
        ],
        "deleted": false
    },
    {
        "dxcc": 182,
        "name": "Navassa Island",
        "prefix": "KP1",
        "prefixes": [
            "KP1"
        ],
        "deleted": false
    },
    {
        "dxcc": 183,
        "name": "Netherlands Borneo",
        "prefix": "PK5",
        "prefixes": [
            "PK5"
        ],
        "deleted": true
    },
    {
        "dxcc": 184,
        "name": "Netherlands New Guinea",
        "prefix": "JZ0",
        "prefixes": [
            "JZ0"
        ],
        "deleted": true
    },
    {
        "dxcc": 185,
        "name": "Solomon Islands",
        "prefix": "H4",
        "prefixes": [
            "H4"
        ],
        "deleted": false
    },
    {
        "dxcc": 186,
        "name": "Newfoundland, Labrador",
        "prefix": "VO",
        "prefixes": [
            "VO"
        ],
        "deleted": true
    },
    {
        "dxcc": 187,
        "name": "Niger",
        "prefix": "5U",
        "prefixes": [
            "5U"
        ],
        "deleted": false
    },
    {
        "dxcc": 188,
        "name": "Niue",
        "prefix": "E6",
        "prefixes": [
            "E6"
        ],
        "deleted": false
    },
    {
        "dxcc": 189,
        "name": "Norfolk Island",
        "prefix": "VK9N",
        "prefixes": [
            "VK9N"
        ],
        "deleted": false
    },
    {
        "dxcc": 190,
        "name": "Samoa",
        "prefix": "5W",
        "prefixes": [
            "5W"
        ],
        "deleted": false
    },
    {
        "dxcc": 191,
        "name": "North Cook Islands",
        "prefix": "E5/N",
        "prefixes": [
            "E5",
            "E5/N"
        ],
        "deleted": false
    },
    {
        "dxcc": 192,
        "name": "Ogasawara Islands",
        "prefix": "JD/O",
        "prefixes": [
            "JD1",
            "JD/O"
        ],
        "deleted": false
    },
    {
        "dxcc": 193,
        "name": "Ryukyu Islands",
        "prefix": "KR6",
        "prefixes": [
            "KR6",
            "KR8",
            "JR6",
            "KA6"
        ],
        "deleted": true
    },
    {
        "dxcc": 194,
        "name": "Okinotorishima",
        "prefix": "7J1",
        "prefixes": [
            "7J1"
        ],
        "deleted": true
    },
    {
        "dxcc": 195,
        "name": "Annobón",
        "prefix": "3C0",
        "prefixes": [
            "3C0"
        ],
        "deleted": false
    },
    {
        "dxcc": 196,
        "name": "Palestine",
        "prefix": "E4",
        "prefixes": [
            "ZC6",
            "4X1",
            "E4"
        ],
        "deleted": true
    },
    {
        "dxcc": 197,
        "name": "Palmyra and Jarvis Islands",
        "prefix": "KH5",
        "prefixes": [
            "KH5"
        ],
        "deleted": false
    },
    {
        "dxcc": 198,
        "name": "Papua Territory",
        "prefix": "P2",
        "prefixes": [
            "P2",
            "VK9"
        ],
        "deleted": true
    },
    {
        "dxcc": 199,
        "name": "Peter I Island",
        "prefix": "3Y/P",
        "prefixes": [
            "3Y",
            "3Y/P"
        ],
        "deleted": false
    },
    {
        "dxcc": 200,
        "name": "Portuguese Timor",
        "prefix": "CR8",
        "prefixes": [
            "CR8",
            "CR10"
        ],
        "deleted": true
    },
    {
        "dxcc": 201,
        "name": "Prince Edward and Marion Islands",
        "prefix": "ZS8",
        "prefixes": [
            "ZS8"
        ],
        "deleted": false
    },
    {
        "dxcc": 202,
        "name": "Puerto Rico",
        "prefix": "KP4",
        "prefixes": [
            "KP3",
            "KP4"
        ],
        "deleted": false
    },
    {
        "dxcc": 203,
        "name": "Andorra",
        "prefix": "C3",
        "prefixes": [
            "C3"
        ],
        "deleted": false
    },
    {
        "dxcc": 204,
        "name": "Revillagigedo Islands",
        "prefix": "XF4",
        "prefixes": [
            "XA4",
            "XB4",
            "XC4",
            "XD4",
            "XE4",
            "XF4",
            "XG4",
            "XH4",
            "XI4"
        ],
        "deleted": false
    },
    {
        "dxcc": 205,
        "name": "Ascension Island",
        "prefix": "ZD8",
        "prefixes": [
            "ZD8"
        ],
        "deleted": false
    },
    {
        "dxcc": 206,
        "name": "Austria",
        "prefix": "OE",
        "prefixes": [
            "OE"
        ],
        "deleted": false
    },
    {
        "dxcc": 207,
        "name": "Rodrigues Island",
        "prefix": "3B9",
        "prefixes": [
            "3B9"
        ],
        "deleted": false
    },
    {
        "dxcc": 208,
        "name": "Ruanda-Urundi",
        "prefix": "9U5",
        "prefixes": [
            "9U5"
        ],
        "deleted": true
    },
    {
        "dxcc": 209,
        "name": "Belgium",
        "prefix": "ON",
        "prefixes": [
            "ON",
            "OO",
            "OP",
            "OQ",
            "OR",
            "OS",
            "OT"
        ],
        "deleted": false
    },
    {
        "dxcc": 210,
        "name": "Saar",
        "prefix": "9S4",
        "prefixes": [
            "9S4"
        ],
        "deleted": true
    },
    {
        "dxcc": 211,
        "name": "Sable Island",
        "prefix": "CY0",
        "prefixes": [
            "CY0"
        ],
        "deleted": false
    },
    {
        "dxcc": 212,
        "name": "Bulgaria",
        "prefix": "LZ",
        "prefixes": [
            "LZ"
        ],
        "deleted": false
    },
    {
        "dxcc": 213,
        "name": "Saint Martin",
        "prefix": "FS",
        "prefixes": [
            "FS",
            "TO"
        ],
        "deleted": false
    },
    {
        "dxcc": 214,
        "name": "Corsica",
        "prefix": "TK",
        "prefixes": [
            "TK"
        ],
        "deleted": false
    },
    {
        "dxcc": 215,
        "name": "Cyprus",
        "prefix": "5B",
        "prefixes": [
            "5B",
            "C4",
            "P3"
        ],
        "deleted": false
    },
    {
        "dxcc": 216,
        "name": "San Andrés and Providencia",
        "prefix": "HK0/A",
        "prefixes": [
            "HK0",
            "HK0/A"
        ],
        "deleted": false
    },
    {
        "dxcc": 217,
        "name": "Desventuradas Islands",
        "prefix": "CE0X",
        "prefixes": [
            "CE0",
            "CE0X"
        ],
        "deleted": false
    },
    {
        "dxcc": 218,
        "name": "Czechoslovakia",
        "prefix": "OK",
        "prefixes": [
            "OK",
            "OL",
            "OM"
        ],
        "deleted": true
    },
    {
        "dxcc": 219,
        "name": "Sao Tome and Principe",
        "prefix": "S9",
        "prefixes": [
            "S9"
        ],
        "deleted": false
    },
    {
        "dxcc": 220,
        "name": "Sarawak",
        "prefix": "VS4",
        "prefixes": [
            "VS4"
        ],
        "deleted": true
    },
    {
        "dxcc": 221,
        "name": "Denmark",
        "prefix": "OZ",
        "prefixes": [
            "OU",
            "OV",
            "OW",
            "OZ"
        ],
        "deleted": false
    },
    {
        "dxcc": 222,
        "name": "Faroe Islands",
        "prefix": "OY",
        "prefixes": [
            "OY"
        ],
        "deleted": false
    },
    {
        "dxcc": 223,
        "name": "England",
        "prefix": "G",
        "prefixes": [
            "G",
            "GX",
            "M"
        ],
        "deleted": false
    },
    {
        "dxcc": 224,
        "name": "Finland",
        "prefix": "OH",
        "prefixes": [
            "OF",
            "OG",
            "OH",
            "OI"
        ],
        "deleted": false
    },
    {
        "dxcc": 225,
        "name": "Sardinia",
        "prefix": "IS",
        "prefixes": [
            "IS0",
            "IM0",
            "IS"
        ],
        "deleted": false
    },
    {
        "dxcc": 226,
        "name": "Saudi Arabia/Iraq Neutral Zone",
        "prefix": "8Z4",
        "prefixes": [
            "8Z4"
        ],
        "deleted": true
    },
    {
        "dxcc": 227,
        "name": "France",
        "prefix": "F",
        "prefixes": [
            "F"
        ],
        "deleted": false
    },
    {
        "dxcc": 228,
        "name": "Serrana Bank & Roncador Cay",
        "prefix": "HK0",
        "prefixes": [
            "HK0",
            "KP3",
            "KS4"
        ],
        "deleted": true
    },
    {
        "dxcc": 229,
        "name": "East Germany",
        "prefix": "DM",
        "prefixes": [
            "DM",
            "Y2",
            "Y3",
            "Y4",
            "Y5",
            "Y6",
            "Y7",
            "Y8",
            "Y9"
        ],
        "deleted": true
    },
    {
        "dxcc": 230,
        "name": "Germany",
        "prefix": "DL",
        "prefixes": [
            "DA",
            "DB",
            "DC",
            "DD",
            "DE",
            "DF",
            "DG",
            "DH",
            "DI",
            "DJ",
            "DK",
            "DL",
            "DM",
            "DN",
            "DO",
            "DP",
            "DQ",
            "DR"
        ],
        "deleted": false
    },
    {
        "dxcc": 231,
        "name": "Sikkim",
        "prefix": "AC3",
        "prefixes": [
            "AC3"
        ],
        "deleted": true
    },
    {
        "dxcc": 232,
        "name": "Somalia",
        "prefix": "T5",
        "prefixes": [
            "T5",
            "6O"
        ],
        "deleted": false
    },
    {
        "dxcc": 233,
        "name": "Gibraltar",
        "prefix": "ZB",
        "prefixes": [
            "ZB2",
            "ZB"
        ],
        "deleted": false
    },
    {
        "dxcc": 234,
        "name": "South Cook Islands",
        "prefix": "E5/S",
        "prefixes": [
            "E5",
            "E5/S"
        ],
        "deleted": false
    },
    {
        "dxcc": 235,
        "name": "South Georgia Island",
        "prefix": "VP8/G",
        "prefixes": [
            "VP0",
            "VP8",
            "LU",
            "VP8/G"
        ],
        "deleted": false
    },
    {
        "dxcc": 236,
        "name": "Greece",
        "prefix": "SV",
        "prefixes": [
            "SV",
            "SW",
            "SX",
            "SY",
            "SZ",
            "J4"
        ],
        "deleted": false
    },
    {
        "dxcc": 237,
        "name": "Greenland",
        "prefix": "OX",
        "prefixes": [
            "OX"
        ],
        "deleted": false
    },
    {
        "dxcc": 238,
        "name": "South Orkney Islands",
        "prefix": "VP8/O",
        "prefixes": [
            "VP0",
            "VP8",
            "LU",
            "VP8/O"
        ],
        "deleted": false
    },
    {
        "dxcc": 239,
        "name": "Hungary",
        "prefix": "HA",
        "prefixes": [
            "HA",
            "HG"
        ],
        "deleted": false
    },
    {
        "dxcc": 240,
        "name": "South Sandwich Islands",
        "prefix": "VP8/S",
        "prefixes": [
            "VP0",
            "VP8",
            "LU",
            "VP8/S"
        ],
        "deleted": false
    },
    {
        "dxcc": 241,
        "name": "South Shetland Islands",
        "prefix": "VP8/H",
        "prefixes": [
            "VP0",
            "VP8",
            "LU",
            "CE9",
            "HF0",
            "4K1",
            "VP8/H"
        ],
        "deleted": false
    },
    {
        "dxcc": 242,
        "name": "Iceland",
        "prefix": "TF",
        "prefixes": [
            "TF"
        ],
        "deleted": false
    },
    {
        "dxcc": 243,
        "name": "People's Democratic Rep. of Yemen",
        "prefix": "VS9A",
        "prefixes": [
            "VS9A",
            "VS9P",
            "VS9S"
        ],
        "deleted": true
    },
    {
        "dxcc": 244,
        "name": "Southern Sudan",
        "prefix": "ST0",
        "prefixes": [
            "ST0"
        ],
        "deleted": true
    },
    {
        "dxcc": 245,
        "name": "Ireland",
        "prefix": "EI",
        "prefixes": [
            "EI",
            "EJ"
        ],
        "deleted": false
    },
    {
        "dxcc": 246,
        "name": "Sovereign Military Order of Malta",
        "prefix": "1A",
        "prefixes": [
            "1A"
        ],
        "deleted": false
    },
    {
        "dxcc": 248,
        "name": "Italy",
        "prefix": "I",
        "prefixes": [
            "I"
        ],
        "deleted": false
    },
    {
        "dxcc": 249,
        "name": "Saint Kitts and Nevis",
        "prefix": "V4",
        "prefixes": [
            "V4"
        ],
        "deleted": false
    },
    {
        "dxcc": 250,
        "name": "St. Helena",
        "prefix": "ZD7",
        "prefixes": [
            "ZD7"
        ],
        "deleted": false
    },
    {
        "dxcc": 251,
        "name": "Liechtenstein",
        "prefix": "HB0",
        "prefixes": [
            "HB0"
        ],
        "deleted": false
    },
    {
        "dxcc": 252,
        "name": "St. Paul Island",
        "prefix": "CY9",
        "prefixes": [
            "CY9"
        ],
        "deleted": false
    },
    {
        "dxcc": 253,
        "name": "Saint Peter and Saint Paul Archipelago",
        "prefix": "PY0S",
        "prefixes": [
            "PP0S",
            "PQ0S",
            "PR0S",
            "PS0S",
            "PT0S",
            "PU0S",
            "PV0S",
            "PW0S",
            "PX0S",
            "PY0S"
        ],
        "deleted": false
    },
    {
        "dxcc": 254,
        "name": "Luxembourg",
        "prefix": "LX",
        "prefixes": [
            "LX"
        ],
        "deleted": false
    },
    {
        "dxcc": 255,
        "name": "St. Maarten, Saba, St. Eustatius",
        "prefix": "PJ",
        "prefixes": [
            "PJ"
        ],
        "deleted": true
    },
    {
        "dxcc": 256,
        "name": "Madeira",
        "prefix": "CT3",
        "prefixes": [
            "CT3"
        ],
        "deleted": false
    },
    {
        "dxcc": 257,
        "name": "Malta",
        "prefix": "9H",
        "prefixes": [
            "9H"
        ],
        "deleted": false
    },
    {
        "dxcc": 258,
        "name": "Sumatra",
        "prefix": "PK4",
        "prefixes": [
            "PK4"
        ],
        "deleted": true
    },
    {
        "dxcc": 259,
        "name": "Svalbard",
        "prefix": "JW",
        "prefixes": [
            "JW"
        ],
        "deleted": false
    },
    {
        "dxcc": 260,
        "name": "Monaco",
        "prefix": "3A",
        "prefixes": [
            "3A"
        ],
        "deleted": false
    },
    {
        "dxcc": 261,
        "name": "Swan Is.",
        "prefix": "KS4",
        "prefixes": [
            "KS4"
        ],
        "deleted": true
    },
    {
        "dxcc": 262,
        "name": "Tajikistan",
        "prefix": "EY",
        "prefixes": [
            "EY"
        ],
        "deleted": false
    },
    {
        "dxcc": 263,
        "name": "Netherlands",
        "prefix": "PA",
        "prefixes": [
            "PA",
            "PB",
            "PC",
            "PD",
            "PE",
            "PF",
            "PG",
            "PH",
            "PI"
        ],
        "deleted": false
    },
    {
        "dxcc": 264,
        "name": "Tangier",
        "prefix": "CN2",
        "prefixes": [
            "CN2"
        ],
        "deleted": true
    },
    {
        "dxcc": 265,
        "name": "Northern Ireland",
        "prefix": "GI",
        "prefixes": [
            "GI",
            "GN"
        ],
        "deleted": false
    },
    {
        "dxcc": 266,
        "name": "Norway",
        "prefix": "LA",
        "prefixes": [
            "LA",
            "LB",
            "LC",
            "LD",
            "LE",
            "LF",
            "LG",
            "LH",
            "LI",
            "LJ",
            "LK",
            "LL",
            "LM",
            "LN"
        ],
        "deleted": false
    },
    {
        "dxcc": 267,
        "name": "Territory of New Guinea",
        "prefix": "P2",
        "prefixes": [
            "P2",
            "VK9"
        ],
        "deleted": true
    },
    {
        "dxcc": 268,
        "name": "Tibet",
        "prefix": "AC4",
        "prefixes": [
            "AC4"
        ],
        "deleted": true
    },
    {
        "dxcc": 269,
        "name": "Poland",
        "prefix": "SP",
        "prefixes": [
            "SN",
            "SO",
            "SP",
            "SQ",
            "SR"
        ],
        "deleted": false
    },
    {
        "dxcc": 270,
        "name": "Tokelau",
        "prefix": "ZK3",
        "prefixes": [
            "ZK3"
        ],
        "deleted": false
    },
    {
        "dxcc": 271,
        "name": "Trieste",
        "prefix": "I1",
        "prefixes": [
            "I1"
        ],
        "deleted": true
    },
    {
        "dxcc": 272,
        "name": "Portugal",
        "prefix": "CT",
        "prefixes": [
            "CQ",
            "CR",
            "CS",
            "CT"
        ],
        "deleted": false
    },
    {
        "dxcc": 273,
        "name": "Trindade and Martin Vaz",
        "prefix": "PY0T",
        "prefixes": [
            "PP0T",
            "PQ0T",
            "PR0T",
            "PS0T",
            "PT0T",
            "PU0T",
            "PV0T",
            "PW0T",
            "PX0T",
            "PY0T"
        ],
        "deleted": false
    },
    {
        "dxcc": 274,
        "name": "Tristan da Cunha and Gough Islands",
        "prefix": "ZD9",
        "prefixes": [
            "ZD9"
        ],
        "deleted": false
    },
    {
        "dxcc": 275,
        "name": "Romania",
        "prefix": "YO",
        "prefixes": [
            "YO",
            "YP",
            "YQ",
            "YR"
        ],
        "deleted": false
    },
    {
        "dxcc": 276,
        "name": "Tromelin Island",
        "prefix": "FT/T",
        "prefixes": [
            "FT/T",
            "TO"
        ],
        "deleted": false
    },
    {
        "dxcc": 277,
        "name": "Saint Pierre and Miquelon",
        "prefix": "FP",
        "prefixes": [
            "FP"
        ],
        "deleted": false
    },
    {
        "dxcc": 278,
        "name": "San Marino",
        "prefix": "T7",
        "prefixes": [
            "T7"
        ],
        "deleted": false
    },
    {
        "dxcc": 279,
        "name": "Scotland",
        "prefix": "GM",
        "prefixes": [
            "GM",
            "GS"
        ],
        "deleted": false
    },
    {
        "dxcc": 280,
        "name": "Turkmenistan",
        "prefix": "EZ",
        "prefixes": [
            "EZ"
        ],
        "deleted": false
    },
    {
        "dxcc": 281,
        "name": "Spain",
        "prefix": "EA",
        "prefixes": [
            "EA",
            "EB",
            "EC",
            "ED",
            "EE",
            "EF",
            "EG",
            "EH"
        ],
        "deleted": false
    },
    {
        "dxcc": 282,
        "name": "Tuvalu",
        "prefix": "T2",
        "prefixes": [
            "T2"
        ],
        "deleted": false
    },
    {
        "dxcc": 283,
        "name": "Sovereign Base Areas of Akrotiri and Dhekelia",
        "prefix": "ZC4",
        "prefixes": [
            "ZC4"
        ],
        "deleted": false
    },
    {
        "dxcc": 284,
        "name": "Sweden",
        "prefix": "SM",
        "prefixes": [
            "SA",
            "SB",
            "SC",
            "SD",
            "SE",
            "SF",
            "SG",
            "SH",
            "SI",
            "SJ",
            "SK",
            "SL",
            "SM",
            "7S",
            "8S"
        ],
        "deleted": false
    },
    {
        "dxcc": 285,
        "name": "US Virgin Islands",
        "prefix": "KP2",
        "prefixes": [
            "KP2"
        ],
        "deleted": false
    },
    {
        "dxcc": 286,
        "name": "Uganda",
        "prefix": "5X",
        "prefixes": [
            "5X"
        ],
        "deleted": false
    },
    {
        "dxcc": 287,
        "name": "Switzerland",
        "prefix": "HB",
        "prefixes": [
            "HB"
        ],
        "deleted": false
    },
    {
        "dxcc": 288,
        "name": "Ukraine",
        "prefix": "UR",
        "prefixes": [
            "UR",
            "US",
            "UT",
            "UU",
            "UV",
            "UW",
            "UX",
            "UY",
            "UZ",
            "EM",
            "EN",
            "EO"
        ],
        "deleted": false
    },
    {
        "dxcc": 289,
        "name": "United Nations Headquarters",
        "prefix": "4U1U",
        "prefixes": [
            "4U",
            "4U1U"
        ],
        "deleted": false
    },
    {
        "dxcc": 291,
        "name": "United States of America",
        "prefix": "K",
        "prefixes": [
            "K",
            "W",
            "N",
            "AA",
            "AB",
            "AC",
            "AD",
            "AE",
            "AF",
            "AG",
            "AH",
            "AI",
            "AJ",
            "AK"
        ],
        "deleted": false
    },
    {
        "dxcc": 292,
        "name": "Uzbekistan",
        "prefix": "UK",
        "prefixes": [
            "UJ",
            "UK",
            "UL",
            "UM"
        ],
        "deleted": false
    },
    {
        "dxcc": 293,
        "name": "Viet Nam",
        "prefix": "3W",
        "prefixes": [
            "3W",
            "XV"
        ],
        "deleted": false
    },
    {
        "dxcc": 294,
        "name": "Wales",
        "prefix": "GW",
        "prefixes": [
            "GW",
            "GC"
        ],
        "deleted": false
    },
    {
        "dxcc": 295,
        "name": "Vatican",
        "prefix": "HV",
        "prefixes": [
            "HV"
        ],
        "deleted": false
    },
    {
        "dxcc": 296,
        "name": "Serbia",
        "prefix": "YU",
        "prefixes": [
            "YT",
            "YU"
        ],
        "deleted": false
    },
    {
        "dxcc": 297,
        "name": "Wake Island",
        "prefix": "KH9",
        "prefixes": [
            "KH9"
        ],
        "deleted": false
    },
    {
        "dxcc": 298,
        "name": "Wallis and Futuna Islands",
        "prefix": "FW",
        "prefixes": [
            "FW"
        ],
        "deleted": false
    },
    {
        "dxcc": 299,
        "name": "West Malaysia",
        "prefix": "9M2",
        "prefixes": [
            "9M2",
            "9M4"
        ],
        "deleted": false
    },
    {
        "dxcc": 301,
        "name": "Gilbert Islands",
        "prefix": "T30",
        "prefixes": [
            "T30"
        ],
        "deleted": false
    },
    {
        "dxcc": 302,
        "name": "Western Sahara",
        "prefix": "S0",
        "prefixes": [
            "S0"
        ],
        "deleted": false
    },
    {
        "dxcc": 303,
        "name": "Willis Island",
        "prefix": "VK9W",
        "prefixes": [
            "VK9W"
        ],
        "deleted": false
    },
    {
        "dxcc": 304,
        "name": "Bahrain",
        "prefix": "A9",
        "prefixes": [
            "A9"
        ],
        "deleted": false
    },
    {
        "dxcc": 305,
        "name": "Bangladesh",
        "prefix": "S2",
        "prefixes": [
            "S2"
        ],
        "deleted": false
    },
    {
        "dxcc": 306,
        "name": "Bhutan",
        "prefix": "A5",
        "prefixes": [
            "A5"
        ],
        "deleted": false
    },
    {
        "dxcc": 307,
        "name": "Zanzibar",
        "prefix": "VQ1",
        "prefixes": [
            "VQ1",
            "5H1"
        ],
        "deleted": true
    },
    {
        "dxcc": 308,
        "name": "Costa Rica",
        "prefix": "TI",
        "prefixes": [
            "TI",
            "TE"
        ],
        "deleted": false
    },
    {
        "dxcc": 309,
        "name": "Myanmar",
        "prefix": "XZ",
        "prefixes": [
            "XY",
            "XZ"
        ],
        "deleted": false
    },
    {
        "dxcc": 312,
        "name": "Cambodia",
        "prefix": "XU",
        "prefixes": [
            "XU"
        ],
        "deleted": false
    },
    {
        "dxcc": 315,
        "name": "Sri Lanka",
        "prefix": "4S",
        "prefixes": [
            "4P",
            "4Q",
            "4R",
            "4S"
        ],
        "deleted": false
    },
    {
        "dxcc": 318,
        "name": "China",
        "prefix": "BY",
        "prefixes": [
            "B",
            "BY"
        ],
        "deleted": false
    },
    {
        "dxcc": 321,
        "name": "Hong Kong",
        "prefix": "VR",
        "prefixes": [
            "VR"
        ],
        "deleted": false
    },
    {
        "dxcc": 324,
        "name": "India",
        "prefix": "VU",
        "prefixes": [
            "VU"
        ],
        "deleted": false
    },
    {
        "dxcc": 327,
        "name": "Indonesia",
        "prefix": "YB",
        "prefixes": [
            "YB",
            "YC",
            "YD",
            "YE",
            "YF",
            "YG",
            "YH"
        ],
        "deleted": false
    },
    {
        "dxcc": 330,
        "name": "Iran",
        "prefix": "EP",
        "prefixes": [
            "EP",
            "EQ"
        ],
        "deleted": false
    },
    {
        "dxcc": 333,
        "name": "Iraq",
        "prefix": "YI",
        "prefixes": [
            "YI"
        ],
        "deleted": false
    },
    {
        "dxcc": 336,
        "name": "Israel",
        "prefix": "4X",
        "prefixes": [
            "4X",
            "4Z"
        ],
        "deleted": false
    },
    {
        "dxcc": 339,
        "name": "Japan",
        "prefix": "JA",
        "prefixes": [
            "JA",
            "JB",
            "JC",
            "JD",
            "JE",
            "JF",
            "JG",
            "JH",
            "JI",
            "JJ",
            "JK",
            "JL",
            "JM",
            "JN",
            "JO",
            "JP",
            "JQ",
            "JR",
            "JS",
            "7J",
            "7K",
            "7L",
            "7M",
            "7N"
        ],
        "deleted": false
    },
    {
        "dxcc": 342,
        "name": "Jordan",
        "prefix": "JY",
        "prefixes": [
            "JY"
        ],
        "deleted": false
    },
    {
        "dxcc": 344,
        "name": "Democratic People's Republic of Korea",
        "prefix": "P5",
        "prefixes": [
            "P5"
        ],
        "deleted": false
    },
    {
        "dxcc": 345,
        "name": "Brunei Darussalam",
        "prefix": "V8",
        "prefixes": [
            "V8"
        ],
        "deleted": false
    },
    {
        "dxcc": 348,
        "name": "Kuwait",
        "prefix": "9K",
        "prefixes": [
            "9K"
        ],
        "deleted": false
    },
    {
        "dxcc": 354,
        "name": "Lebanon",
        "prefix": "OD",
        "prefixes": [
            "OD"
        ],
        "deleted": false
    },
    {
        "dxcc": 363,
        "name": "Mongolia",
        "prefix": "JT",
        "prefixes": [
            "JT",
            "JU",
            "JV"
        ],
        "deleted": false
    },
    {
        "dxcc": 369,
        "name": "Nepal",
        "prefix": "9N",
        "prefixes": [
            "9N"
        ],
        "deleted": false
    },
    {
        "dxcc": 370,
        "name": "Oman",
        "prefix": "A4",
        "prefixes": [
            "A4"
        ],
        "deleted": false
    },
    {
        "dxcc": 372,
        "name": "Pakistan",
        "prefix": "AP",
        "prefixes": [
            "AP",
            "AQ",
            "AR",
            "AS"
        ],
        "deleted": false
    },
    {
        "dxcc": 375,
        "name": "Philippines",
        "prefix": "DU",
        "prefixes": [
            "DU",
            "DV",
            "DW",
            "DX",
            "DY",
            "DZ",
            "4D",
            "4E",
            "4F",
            "4G",
            "4H",
            "4I"
        ],
        "deleted": false
    },
    {
        "dxcc": 376,
        "name": "Qatar",
        "prefix": "A7",
        "prefixes": [
            "A7"
        ],
        "deleted": false
    },
    {
        "dxcc": 378,
        "name": "Saudi Arabia",
        "prefix": "HZ",
        "prefixes": [
            "HZ"
        ],
        "deleted": false
    },
    {
        "dxcc": 379,
        "name": "Seychelles",
        "prefix": "S7",
        "prefixes": [
            "S7"
        ],
        "deleted": false
    },
    {
        "dxcc": 381,
        "name": "Singapore",
        "prefix": "9V",
        "prefixes": [
            "9V"
        ],
        "deleted": false
    },
    {
        "dxcc": 382,
        "name": "Djibouti",
        "prefix": "J2",
        "prefixes": [
            "J2"
        ],
        "deleted": false
    },
    {
        "dxcc": 384,
        "name": "Syria",
        "prefix": "YK",
        "prefixes": [
            "YK"
        ],
        "deleted": false
    },
    {
        "dxcc": 386,
        "name": "Taiwan",
        "prefix": "BU",
        "prefixes": [
            "BU",
            "BV",
            "BW",
            "BX"
        ],
        "deleted": false
    },
    {
        "dxcc": 387,
        "name": "Thailand",
        "prefix": "HS",
        "prefixes": [
            "HS",
            "E2"
        ],
        "deleted": false
    },
    {
        "dxcc": 390,
        "name": "Turkey",
        "prefix": "TA",
        "prefixes": [
            "TA",
            "TB",
            "TC"
        ],
        "deleted": false
    },
    {
        "dxcc": 391,
        "name": "United Arab Emirates",
        "prefix": "A6",
        "prefixes": [
            "A6"
        ],
        "deleted": false
    },
    {
        "dxcc": 400,
        "name": "Algeria",
        "prefix": "7R",
        "prefixes": [
            "7R",
            "7T",
            "7U",
            "7V",
            "7W",
            "7X",
            "7Y"
        ],
        "deleted": false
    },
    {
        "dxcc": 401,
        "name": "Angola",
        "prefix": "D2",
        "prefixes": [
            "D2",
            "D3"
        ],
        "deleted": false
    },
    {
        "dxcc": 402,
        "name": "Botswana",
        "prefix": "A2",
        "prefixes": [
            "A2",
            "8O"
        ],
        "deleted": false
    },
    {
        "dxcc": 404,
        "name": "Burundi",
        "prefix": "9U",
        "prefixes": [
            "9U"
        ],
        "deleted": false
    },
    {
        "dxcc": 406,
        "name": "Cameroon",
        "prefix": "TJ",
        "prefixes": [
            "TJ"
        ],
        "deleted": false
    },
    {
        "dxcc": 408,
        "name": "Central African Republic",
        "prefix": "TL",
        "prefixes": [
            "TL"
        ],
        "deleted": false
    },
    {
        "dxcc": 409,
        "name": "Cape Verde",
        "prefix": "D4",
        "prefixes": [
            "D4"
        ],
        "deleted": false
    },
    {
        "dxcc": 410,
        "name": "Chad",
        "prefix": "TT",
        "prefixes": [
            "TT"
        ],
        "deleted": false
    },
    {
        "dxcc": 411,
        "name": "Comoros",
        "prefix": "D6",
        "prefixes": [
            "D6"
        ],
        "deleted": false
    },
    {
        "dxcc": 412,
        "name": "Republic of the Congo",
        "prefix": "TN",
        "prefixes": [
            "TN"
        ],
        "deleted": false
    },
    {
        "dxcc": 414,
        "name": "Democratic Republic of the Congo",
        "prefix": "9O",
        "prefixes": [
            "9O",
            "9P",
            "9Q",
            "9R",
            "9S",
            "9T"
        ],
        "deleted": false
    },
    {
        "dxcc": 416,
        "name": "Benin",
        "prefix": "TY",
        "prefixes": [
            "TY"
        ],
        "deleted": false
    },
    {
        "dxcc": 420,
        "name": "Gabon",
        "prefix": "TR",
        "prefixes": [
            "TR"
        ],
        "deleted": false
    },
    {
        "dxcc": 422,
        "name": "The Gambia",
        "prefix": "C5",
        "prefixes": [
            "C5"
        ],
        "deleted": false
    },
    {
        "dxcc": 424,
        "name": "Ghana",
        "prefix": "9G",
        "prefixes": [
            "9G"
        ],
        "deleted": false
    },
    {
        "dxcc": 428,
        "name": "Côte d'Ivoire",
        "prefix": "TU",
        "prefixes": [
            "TU"
        ],
        "deleted": false
    },
    {
        "dxcc": 430,
        "name": "Kenya",
        "prefix": "5Y",
        "prefixes": [
            "5Y",
            "5Z"
        ],
        "deleted": false
    },
    {
        "dxcc": 432,
        "name": "Lesotho",
        "prefix": "7P",
        "prefixes": [
            "7P"
        ],
        "deleted": false
    },
    {
        "dxcc": 434,
        "name": "Liberia",
        "prefix": "EL",
        "prefixes": [
            "EL"
        ],
        "deleted": false
    },
    {
        "dxcc": 436,
        "name": "Libya",
        "prefix": "5A",
        "prefixes": [
            "5A"
        ],
        "deleted": false
    },
    {
        "dxcc": 438,
        "name": "Madagascar",
        "prefix": "5R",
        "prefixes": [
            "5R"
        ],
        "deleted": false
    },
    {
        "dxcc": 440,
        "name": "Malawi",
        "prefix": "7Q",
        "prefixes": [
            "7Q"
        ],
        "deleted": false
    },
    {
        "dxcc": 442,
        "name": "Mali",
        "prefix": "TZ",
        "prefixes": [
            "TZ"
        ],
        "deleted": false
    },
    {
        "dxcc": 444,
        "name": "Mauritania",
        "prefix": "5T",
        "prefixes": [
            "5T"
        ],
        "deleted": false
    },
    {
        "dxcc": 446,
        "name": "Morocco",
        "prefix": "CN",
        "prefixes": [
            "CN",
            "5C",
            "5D",
            "5E",
            "5F",
            "5G"
        ],
        "deleted": false
    },
    {
        "dxcc": 450,
        "name": "Nigeria",
        "prefix": "5N",
        "prefixes": [
            "5N"
        ],
        "deleted": false
    },
    {
        "dxcc": 452,
        "name": "Zimbabwe",
        "prefix": "Z2",
        "prefixes": [
            "Z2"
        ],
        "deleted": false
    },
    {
        "dxcc": 453,
        "name": "Réunion",
        "prefix": "FR",
        "prefixes": [
            "FR",
            "TO"
        ],
        "deleted": false
    },
    {
        "dxcc": 454,
        "name": "Rwanda",
        "prefix": "9X",
        "prefixes": [
            "9X"
        ],
        "deleted": false
    },
    {
        "dxcc": 456,
        "name": "Senegal",
        "prefix": "6V",
        "prefixes": [
            "6V",
            "6W"
        ],
        "deleted": false
    },
    {
        "dxcc": 458,
        "name": "Sierra Leone",
        "prefix": "9L",
        "prefixes": [
            "9L"
        ],
        "deleted": false
    },
    {
        "dxcc": 460,
        "name": "Rotuma Island",
        "prefix": "3D2R",
        "prefixes": [
            "3D2",
            "3D2R"
        ],
        "deleted": false
    },
    {
        "dxcc": 462,
        "name": "South Africa",
        "prefix": "ZR",
        "prefixes": [
            "ZR",
            "ZS",
            "ZT",
            "ZU"
        ],
        "deleted": false
    },
    {
        "dxcc": 464,
        "name": "Namibia",
        "prefix": "V5",
        "prefixes": [
            "V5"
        ],
        "deleted": false
    },
    {
        "dxcc": 466,
        "name": "Sudan",
        "prefix": "ST",
        "prefixes": [
            "ST"
        ],
        "deleted": false
    },
    {
        "dxcc": 468,
        "name": "Eswatini",
        "prefix": "3DA",
        "prefixes": [
            "3DA"
        ],
        "deleted": false
    },
    {
        "dxcc": 470,
        "name": "Tanzania",
        "prefix": "5H",
        "prefixes": [
            "5H",
            "5I"
        ],
        "deleted": false
    },
    {
        "dxcc": 474,
        "name": "Tunisia",
        "prefix": "3V",
        "prefixes": [
            "3V"
        ],
        "deleted": false
    },
    {
        "dxcc": 478,
        "name": "Egypt",
        "prefix": "SU",
        "prefixes": [
            "SU"
        ],
        "deleted": false
    },
    {
        "dxcc": 480,
        "name": "Burkina Faso",
        "prefix": "XT",
        "prefixes": [
            "XT"
        ],
        "deleted": false
    },
    {
        "dxcc": 482,
        "name": "Zambia",
        "prefix": "9I",
        "prefixes": [
            "9I",
            "9J"
        ],
        "deleted": false
    },
    {
        "dxcc": 483,
        "name": "Togo",
        "prefix": "5V",
        "prefixes": [
            "5V"
        ],
        "deleted": false
    },
    {
        "dxcc": 488,
        "name": "Walvis Bay",
        "prefix": "ZS9",
        "prefixes": [
            "ZS9"
        ],
        "deleted": true
    },
    {
        "dxcc": 489,
        "name": "Conway Reef",
        "prefix": "3D2C",
        "prefixes": [
            "3D2",
            "3D2C"
        ],
        "deleted": false
    },
    {
        "dxcc": 490,
        "name": "Banaba",
        "prefix": "T33",
        "prefixes": [
            "T33"
        ],
        "deleted": false
    },
    {
        "dxcc": 492,
        "name": "Yemen",
        "prefix": "7O",
        "prefixes": [
            "7O"
        ],
        "deleted": false
    },
    {
        "dxcc": 493,
        "name": "Penguin Is.",
        "prefix": "ZS0",
        "prefixes": [
            "ZS0",
            "ZS1"
        ],
        "deleted": true
    },
    {
        "dxcc": 497,
        "name": "Croatia",
        "prefix": "9A",
        "prefixes": [
            "9A"
        ],
        "deleted": false
    },
    {
        "dxcc": 499,
        "name": "Slovenia",
        "prefix": "S5",
        "prefixes": [
            "S5"
        ],
        "deleted": false
    },
    {
        "dxcc": 501,
        "name": "Bosnia-Herzegovina",
        "prefix": "E7",
        "prefixes": [
            "E7"
        ],
        "deleted": false
    },
    {
        "dxcc": 502,
        "name": "North Macedonia",
        "prefix": "Z3",
        "prefixes": [
            "Z3"
        ],
        "deleted": false
    },
    {
        "dxcc": 503,
        "name": "Czech Republic",
        "prefix": "OK",
        "prefixes": [
            "OK",
            "OL"
        ],
        "deleted": false
    },
    {
        "dxcc": 504,
        "name": "Slovakia",
        "prefix": "OM",
        "prefixes": [
            "OM"
        ],
        "deleted": false
    },
    {
        "dxcc": 505,
        "name": "Pratas Island",
        "prefix": "BV9P",
        "prefixes": [
            "BV9P"
        ],
        "deleted": false
    },
    {
        "dxcc": 506,
        "name": "Scarborough Shoal",
        "prefix": "BS7",
        "prefixes": [
            "BS7"
        ],
        "deleted": false
    },
    {
        "dxcc": 507,
        "name": "Temotu Province",
        "prefix": "H40",
        "prefixes": [
            "H40"
        ],
        "deleted": false
    },
    {
        "dxcc": 508,
        "name": "Austral Islands",
        "prefix": "FO",
        "prefixes": [
            "FO",
            "TO"
        ],
        "deleted": false
    },
    {
        "dxcc": 509,
        "name": "Marquesas Islands",
        "prefix": "FO",
        "prefixes": [
            "FO",
            "TX"
        ],
        "deleted": false
    },
    {
        "dxcc": 510,
        "name": "Palestine",
        "prefix": "E4",
        "prefixes": [
            "E4"
        ],
        "deleted": false
    },
    {
        "dxcc": 511,
        "name": "Timor-Leste",
        "prefix": "4W",
        "prefixes": [
            "4W"
        ],
        "deleted": false
    },
    {
        "dxcc": 512,
        "name": "Chesterfield Islands",
        "prefix": "FK",
        "prefixes": [
            "FK",
            "TX"
        ],
        "deleted": false
    },
    {
        "dxcc": 513,
        "name": "Ducie Island",
        "prefix": "VP6",
        "prefixes": [
            "VP6"
        ],
        "deleted": false
    },
    {
        "dxcc": 514,
        "name": "Montenegro",
        "prefix": "4O",
        "prefixes": [
            "4O"
        ],
        "deleted": false
    },
    {
        "dxcc": 515,
        "name": "Swains Island",
        "prefix": "KH8/S",
        "prefixes": [
            "KH8",
            "KH8/S"
        ],
        "deleted": false
    },
    {
        "dxcc": 516,
        "name": "Saint Barthélemy",
        "prefix": "FJ",
        "prefixes": [
            "FJ",
            "TO"
        ],
        "deleted": false
    },
    {
        "dxcc": 517,
        "name": "Curaçao",
        "prefix": "PJ2",
        "prefixes": [
            "PJ2"
        ],
        "deleted": false
    },
    {
        "dxcc": 518,
        "name": "Sint Maarten",
        "prefix": "PJ7",
        "prefixes": [
            "PJ7"
        ],
        "deleted": false
    },
    {
        "dxcc": 519,
        "name": "Saba and Sint Eustatius",
        "prefix": "PJ5",
        "prefixes": [
            "PJ5",
            "PJ6"
        ],
        "deleted": false
    },
    {
        "dxcc": 520,
        "name": "Bonaire",
        "prefix": "PJ4",
        "prefixes": [
            "PJ4"
        ],
        "deleted": false
    },
    {
        "dxcc": 521,
        "name": "South Sudan",
        "prefix": "Z8",
        "prefixes": [
            "Z8"
        ],
        "deleted": false
    },
    {
        "dxcc": 522,
        "name": "Kosovo",
        "prefix": "Z6",
        "prefixes": [
            "Z6"
        ],
        "deleted": false
    }
];
