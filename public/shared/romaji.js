/**
 * shared/romaji.js
 *
 * Client-side Japanese -> Romaji display conversion.
 *
 * Why this exists (PART 20-22, BUG 5): when the target language is Japanese the
 * visible conversation UI must show Romaji only. The RAW transcript is kept
 * intact for memory extraction — this module is a *display* transform and is
 * never applied to stored transcript data.
 *
 * Coverage:
 *   - full hiragana and katakana, including small kana and digraphs
 *   - sokuon (っ/ッ) gemination
 *   - chōonpu (ー) long vowels, and long-vowel kana sequences
 *   - a dictionary of common lesson vocabulary written in kanji
 *   - per-character readings for common kanji outside the dictionary
 *   - Japanese punctuation and full-width digits/letters
 *
 * Anything that still cannot be read is replaced with a visible placeholder
 * rather than being shown as Japanese script.
 *
 * Dependency-free: runs unchanged in Node and the browser.
 */

/** Placeholder for a kanji we have no reading for. Never leaks native script. */
const UNKNOWN = '[?]';

// ---------------------------------------------------------------------------
// 1. Kana tables
// ---------------------------------------------------------------------------

/** Base (non-digraph) hiragana readings. */
const KANA = Object.freeze({
  あ: 'a', い: 'i', う: 'u', え: 'e', お: 'o',
  か: 'ka', き: 'ki', く: 'ku', け: 'ke', こ: 'ko',
  が: 'ga', ぎ: 'gi', ぐ: 'gu', げ: 'ge', ご: 'go',
  さ: 'sa', し: 'shi', す: 'su', せ: 'se', そ: 'so',
  ざ: 'za', じ: 'ji', ず: 'zu', ぜ: 'ze', ぞ: 'zo',
  た: 'ta', ち: 'chi', つ: 'tsu', て: 'te', と: 'to',
  だ: 'da', ぢ: 'ji', づ: 'zu', で: 'de', ど: 'do',
  な: 'na', に: 'ni', ぬ: 'nu', ね: 'ne', の: 'no',
  は: 'ha', ひ: 'hi', ふ: 'fu', へ: 'he', ほ: 'ho',
  ば: 'ba', び: 'bi', ぶ: 'bu', べ: 'be', ぼ: 'bo',
  ぱ: 'pa', ぴ: 'pi', ぷ: 'pu', ぺ: 'pe', ぽ: 'po',
  ま: 'ma', み: 'mi', む: 'mu', め: 'me', も: 'mo',
  や: 'ya', ゆ: 'yu', よ: 'yo',
  ら: 'ra', り: 'ri', る: 'ru', れ: 're', ろ: 'ro',
  わ: 'wa', ゐ: 'wi', ゑ: 'we', を: 'wo', ん: 'n',
  ゔ: 'vu',
  ぁ: 'a', ぃ: 'i', ぅ: 'u', ぇ: 'e', ぉ: 'o',
  ゃ: 'ya', ゅ: 'yu', ょ: 'yo', ゎ: 'wa',
});

/** Two-kana sequences that form a single sound. Checked before KANA. */
const DIGRAPHS = Object.freeze({
  きゃ: 'kya', きゅ: 'kyu', きょ: 'kyo', きぇ: 'kye',
  ぎゃ: 'gya', ぎゅ: 'gyu', ぎょ: 'gyo', ぎぇ: 'gye',
  しゃ: 'sha', しゅ: 'shu', しょ: 'sho', しぇ: 'she', しぃ: 'shi',
  じゃ: 'ja', じゅ: 'ju', じょ: 'jo', じぇ: 'je',
  ちゃ: 'cha', ちゅ: 'chu', ちょ: 'cho', ちぇ: 'che',
  ぢゃ: 'ja', ぢゅ: 'ju', ぢょ: 'jo',
  にゃ: 'nya', にゅ: 'nyu', にょ: 'nyo', にぇ: 'nye',
  ひゃ: 'hya', ひゅ: 'hyu', ひょ: 'hyo', ひぇ: 'hye',
  びゃ: 'bya', びゅ: 'byu', びょ: 'byo',
  ぴゃ: 'pya', ぴゅ: 'pyu', ぴょ: 'pyo',
  みゃ: 'mya', みゅ: 'myu', みょ: 'myo',
  りゃ: 'rya', りゅ: 'ryu', りょ: 'ryo', りぇ: 'rye',
  ふぁ: 'fa', ふぃ: 'fi', ふぇ: 'fe', ふぉ: 'fo', ふゅ: 'fyu',
  ゔぁ: 'va', ゔぃ: 'vi', ゔぇ: 've', ゔぉ: 'vo',
  てぃ: 'ti', てゅ: 'tyu', でぃ: 'di', でゅ: 'dyu',
  とぅ: 'tu', どぅ: 'du',
  うぃ: 'wi', うぇ: 'we', うぉ: 'wo',
  つぁ: 'tsa', つぃ: 'tsi', つぇ: 'tse', つぉ: 'tso',
  いぇ: 'ye',
  くぁ: 'kwa', くぃ: 'kwi', くぇ: 'kwe', くぉ: 'kwo',
  ぐぁ: 'gwa',
});

/** Japanese punctuation and symbols mapped to Latin equivalents. */
const PUNCTUATION = Object.freeze({
  '。': '.', '、': ',', '，': ',', '．': '.',
  '！': '!', '？': '?', '：': ':', '；': ';',
  '「': '"', '」': '"', '『': '"', '』': '"',
  '（': '(', '）': ')', '［': '[', '］': ']', '｛': '{', '｝': '}',
  '〜': '~', '～': '~', '・': ' ', '　': ' ',
  '＝': '=', '＋': '+', '％': '%', '＆': '&', '＃': '#', '＠': '@',
  '…': '...', '‥': '..', '〆': '', '々': '',
});

/**
 * Particle readings. In modern Japanese を is *always* the object particle, so
 * it always reads "o". は and へ only read "wa"/"e" when they follow a word
 * boundary, which the converter tracks explicitly.
 */
const PARTICLE_READINGS = Object.freeze({ は: 'wa', へ: 'e', を: 'o' });

// ---------------------------------------------------------------------------
// 2. Kanji vocabulary dictionary (longest-match, whole words)
// ---------------------------------------------------------------------------

/**
 * Common lesson vocabulary that contains kanji. Matched longest-first, so
 * entries may overlap freely.
 */
const WORDS = Object.freeze({
  // Greetings and set phrases. These are kana-only or fixed expressions where
  // ordinary segmentation would produce the wrong reading (こんにちは -> "wa").
  こんにちは: 'konnichiwa', こんばんは: 'konbanwa', おはよう: 'ohayou',
  おはようございます: 'ohayou gozaimasu', ありがとう: 'arigatou',
  ありがとうございます: 'arigatou gozaimasu', すみません: 'sumimasen',
  ごめんなさい: 'gomennasai', さようなら: 'sayounara', おやすみなさい: 'oyasuminasai',
  はじめまして: 'hajimemashite', よろしく: 'yoroshiku', おねがいします: 'onegaishimasu',
  いただきます: 'itadakimasu', ごちそうさま: 'gochisousama', では: 'dewa',
  こんにちわ: 'konnichiwa',
  // Kana phrases whose trailing は is the topic particle.
  これは: 'kore wa', それは: 'sore wa', あれは: 'are wa', わたしは: 'watashi wa',
  ここは: 'koko wa', そこは: 'soko wa', あそこは: 'asoko wa',
  きょうは: 'kyou wa', あしたは: 'ashita wa', いまは: 'ima wa',
  なまえは: 'namae wa', にほんごは: 'nihongo wa', てんきは: 'tenki wa',
  御早う: 'ohayou',
  御願いします: 'onegaishimasu', お願いします: 'onegaishimasu', お願い: 'onegai',
  有難う: 'arigatou', 有り難う: 'arigatou',
  済みません: 'sumimasen', 御免なさい: 'gomennasai',
  初めまして: 'hajimemashite', 宜しく: 'yoroshiku',
  頂きます: 'itadakimasu', 御馳走様: 'gochisousama',
  行ってきます: 'ittekimasu', 只今: 'tadaima', 御帰り: 'okaeri',
  // People
  私: 'watashi', 僕: 'boku', 俺: 'ore', 貴方: 'anata',
  彼: 'kare', 彼女: 'kanojo', 皆さん: 'minasan', 人: 'hito',
  友達: 'tomodachi', 家族: 'kazoku', 両親: 'ryoushin',
  父: 'chichi', 母: 'haha', 兄: 'ani', 姉: 'ane', 弟: 'otouto', 妹: 'imouto',
  息子: 'musuko', 娘: 'musume', 子供: 'kodomo', 赤ちゃん: 'akachan',
  お父さん: 'otousan', お母さん: 'okaasan', お兄さん: 'oniisan', お姉さん: 'oneesan',
  先生: 'sensei', 学生: 'gakusei', 生徒: 'seito', 会社員: 'kaishain',
  医者: 'isha', 店員: 'tenin', 名前: 'namae',
  // Places
  日本: 'nihon', 東京: 'toukyou', 大阪: 'oosaka', 京都: 'kyouto',
  日本人: 'nihonjin', 外国: 'gaikoku', 外国人: 'gaikokujin',
  家: 'ie', 学校: 'gakkou', 大学: 'daigaku', 会社: 'kaisha',
  駅: 'eki', 空港: 'kuukou', 病院: 'byouin', 銀行: 'ginkou',
  郵便局: 'yuubinkyoku', 図書館: 'toshokan', 公園: 'kouen',
  店: 'mise', 本屋: 'honya', 部屋: 'heya', 台所: 'daidokoro',
  教室: 'kyoushitsu', 事務所: 'jimusho', 道: 'michi', 町: 'machi',
  市: 'shi', 国: 'kuni', 世界: 'sekai', 海: 'umi', 山: 'yama', 川: 'kawa',
  // Transport
  電車: 'densha', 地下鉄: 'chikatetsu', 新幹線: 'shinkansen',
  電話: 'denwa', 自転車: 'jitensha', 自動車: 'jidousha',
  飛行機: 'hikouki', 車: 'kuruma', 切符: 'kippu', 荷物: 'nimotsu',
  // Time
  今: 'ima', 今日: 'kyou', 明日: 'ashita', 昨日: 'kinou',
  毎日: 'mainichi', 今週: 'konshuu', 来週: 'raishuu', 先週: 'senshuu',
  今月: 'kongetsu', 来月: 'raigetsu', 先月: 'sengetsu',
  今年: 'kotoshi', 来年: 'rainen', 去年: 'kyonen',
  朝: 'asa', 昼: 'hiru', 夜: 'yoru', 午前: 'gozen', 午後: 'gogo',
  時間: 'jikan', 時計: 'tokei', 分: 'fun', 秒: 'byou',
  週末: 'shuumatsu', 曜日: 'youbi',
  月曜日: 'getsuyoubi', 火曜日: 'kayoubi', 水曜日: 'suiyoubi',
  木曜日: 'mokuyoubi', 金曜日: 'kinyoubi', 土曜日: 'doyoubi', 日曜日: 'nichiyoubi',
  春: 'haru', 夏: 'natsu', 秋: 'aki', 冬: 'fuyu',
  誕生日: 'tanjoubi', 休み: 'yasumi',
  // Food and drink
  御飯: 'gohan', ご飯: 'gohan', 朝御飯: 'asagohan', 朝ご飯: 'asagohan',
  昼御飯: 'hirugohan', 昼ご飯: 'hirugohan', 晩御飯: 'bangohan', 晩ご飯: 'bangohan',
  食べ物: 'tabemono', 飲み物: 'nomimono', 料理: 'ryouri',
  水: 'mizu', 御茶: 'ocha', お茶: 'ocha', 牛乳: 'gyuunyuu',
  肉: 'niku', 魚: 'sakana', 野菜: 'yasai', 果物: 'kudamono',
  卵: 'tamago', 米: 'kome', 塩: 'shio', 砂糖: 'satou',
  弁当: 'bentou', 喫茶店: 'kissaten', 食堂: 'shokudou',
  // Everyday objects
  本: 'hon', 雑誌: 'zasshi', 新聞: 'shinbun', 手紙: 'tegami',
  紙: 'kami', 鉛筆: 'enpitsu', 万年筆: 'mannenhitsu', 辞書: 'jisho',
  机: 'tsukue', 椅子: 'isu', 窓: 'mado', 戸: 'to', 鍵: 'kagi',
  服: 'fuku', 靴: 'kutsu', 帽子: 'boushi', 傘: 'kasa', 鞄: 'kaban',
  財布: 'saifu', 御金: 'okane', お金: 'okane', 円: 'en',
  写真: 'shashin', 音楽: 'ongaku', 映画: 'eiga', 犬: 'inu', 猫: 'neko',
  // Study words
  日本語: 'nihongo', 英語: 'eigo', 言葉: 'kotoba', 漢字: 'kanji',
  文法: 'bunpou', 単語: 'tango', 質問: 'shitsumon', 答え: 'kotae',
  宿題: 'shukudai', 試験: 'shiken', 練習: 'renshuu', 勉強: 'benkyou',
  意味: 'imi', 発音: 'hatsuon', 会話: 'kaiwa',
  // Common verbs (dictionary and polite forms)
  行きます: 'ikimasu', 行く: 'iku', 来ます: 'kimasu', 来る: 'kuru',
  帰ります: 'kaerimasu', 帰る: 'kaeru', 食べます: 'tabemasu', 食べる: 'taberu',
  飲みます: 'nomimasu', 飲む: 'nomu', 見ます: 'mimasu', 見る: 'miru',
  聞きます: 'kikimasu', 聞く: 'kiku', 話します: 'hanashimasu', 話す: 'hanasu',
  読みます: 'yomimasu', 読む: 'yomu', 書きます: 'kakimasu', 書く: 'kaku',
  買います: 'kaimasu', 買う: 'kau', 使います: 'tsukaimasu', 使う: 'tsukau',
  作ります: 'tsukurimasu', 作る: 'tsukuru', 待ちます: 'machimasu', 待つ: 'matsu',
  分かります: 'wakarimasu', 分かる: 'wakaru', 知ります: 'shirimasu', 知る: 'shiru',
  出ます: 'demasu', 出る: 'deru', 入ります: 'hairimasu', 入る: 'hairu',
  起きます: 'okimasu', 起きる: 'okiru', 寝ます: 'nemasu', 寝る: 'neru',
  働きます: 'hatarakimasu', 働く: 'hataraku', 休みます: 'yasumimasu',
  教えます: 'oshiemasu', 教える: 'oshieru', 習います: 'naraimasu', 習う: 'narau',
  会います: 'aimasu', 会う: 'au', 持ちます: 'mochimasu', 持つ: 'motsu',
  住みます: 'sumimasu', 住む: 'sumu', 思います: 'omoimasu', 思う: 'omou',
  言います: 'iimasu', 言う: 'iu', 立ちます: 'tachimasu', 立つ: 'tatsu',
  座ります: 'suwarimasu', 座る: 'suwaru', 歩きます: 'arukimasu', 歩く: 'aruku',
  走ります: 'hashirimasu', 走る: 'hashiru', 泳ぎます: 'oyogimasu', 泳ぐ: 'oyogu',
  遊びます: 'asobimasu', 遊ぶ: 'asobu', 笑います: 'waraimasu', 笑う: 'warau',
  // Adjectives
  大きい: 'ookii', 小さい: 'chiisai', 新しい: 'atarashii', 古い: 'furui',
  高い: 'takai', 安い: 'yasui', 低い: 'hikui', 長い: 'nagai', 短い: 'mijikai',
  良い: 'yoi', 悪い: 'warui', 早い: 'hayai', 速い: 'hayai', 遅い: 'osoi',
  暑い: 'atsui', 寒い: 'samui', 熱い: 'atsui', 冷たい: 'tsumetai',
  多い: 'ooi', 少ない: 'sukunai', 難しい: 'muzukashii', 易しい: 'yasashii',
  楽しい: 'tanoshii', 面白い: 'omoshiroi', 忙しい: 'isogashii',
  美味しい: 'oishii', 綺麗: 'kirei', 元気: 'genki', 静か: 'shizuka',
  有名: 'yuumei', 親切: 'shinsetsu', 便利: 'benri', 大丈夫: 'daijoubu',
  上手: 'jouzu', 下手: 'heta', 好き: 'suki', 嫌い: 'kirai',
  // Numbers and counters
  一: 'ichi', 二: 'ni', 三: 'san', 四: 'yon', 五: 'go',
  六: 'roku', 七: 'nana', 八: 'hachi', 九: 'kyuu', 十: 'juu',
  百: 'hyaku', 千: 'sen', 万: 'man', 半: 'han',
  一つ: 'hitotsu', 二つ: 'futatsu', 三つ: 'mittsu', 四つ: 'yottsu', 五つ: 'itsutsu',
  一人: 'hitori', 二人: 'futari', 一日: 'ichinichi', 二日: 'futsuka',
  一時: 'ichiji', 二時: 'niji', 三時: 'sanji', 四時: 'yoji',
  // Direction / position
  上: 'ue', 下: 'shita', 中: 'naka', 外: 'soto', 前: 'mae', 後ろ: 'ushiro',
  右: 'migi', 左: 'hidari', 近く: 'chikaku', 隣: 'tonari', 間: 'aida',
  東: 'higashi', 西: 'nishi', 南: 'minami', 北: 'kita',
  // Misc high-frequency
  何: 'nani', 何時: 'nanji', 誰: 'dare', 何処: 'doko', 何故: 'naze',
  仕事: 'shigoto', 天気: 'tenki', 雨: 'ame', 雪: 'yuki', 風: 'kaze',
  空: 'sora', 花: 'hana', 木: 'ki', 森: 'mori', 林: 'hayashi', 池: 'ike',
  湖: 'mizuumi', 島: 'shima', 石: 'ishi', 星: 'hoshi', 光: 'hikari',
  電気: 'denki', 部長: 'buchou', 社長: 'shachou',
  色: 'iro', 白: 'shiro', 黒: 'kuro', 赤: 'aka', 青: 'ao', 黄色: 'kiiro',
  体: 'karada', 頭: 'atama', 目: 'me', 耳: 'mimi', 口: 'kuchi', 手: 'te', 足: 'ashi',
  声: 'koe', 心: 'kokoro', 気: 'ki', 力: 'chikara',
  // Compounds promoted from the per-character table
  空気: 'kuuki',
  楽器: 'gakki',
  習字: 'shuuji',
  部分: 'bubun',
  都合: 'tsugou',
  病気: 'byouki',
  料金: 'ryoukin',
  発車: 'hassha',
  見付: 'mitsu',
  決定: 'kettei',
  事務: 'jimu',
  紙面: 'shimen',
  物語: 'monogatari',
  内容: 'naiyou',
  誰か: 'dareka',
  本当: 'hontou',
});

/**
 * Per-character fallback readings for kanji not covered by WORDS.
 * These are the most common on'yomi/kun'yomi and are a best effort — a single
 * plausible Latin reading always beats showing the character itself.
 */
const KANJI_CHARS = Object.freeze({
  日: 'nichi', 月: 'getsu', 火: 'ka', 水: 'sui', 木: 'moku', 金: 'kin', 土: 'do',
  年: 'nen', 時: 'ji', 分: 'fun', 半: 'han', 毎: 'mai', 週: 'shuu', 曜: 'you',
  今: 'ima', 昨: 'saku', 明: 'mei', 朝: 'asa', 昼: 'hiru', 夜: 'yoru', 晩: 'ban',
  春: 'haru', 夏: 'natsu', 秋: 'aki', 冬: 'fuyu', 午: 'go', 前: 'mae', 後: 'go',
  人: 'hito', 私: 'watashi', 僕: 'boku', 君: 'kimi', 彼: 'kare', 女: 'onna', 男: 'otoko',
  父: 'chichi', 母: 'haha', 兄: 'ani', 姉: 'ane', 弟: 'otouto', 妹: 'imouto',
  子: 'ko', 友: 'tomo', 達: 'tachi', 家: 'ie', 族: 'zoku', 親: 'oya',
  先: 'sen', 生: 'sei', 学: 'gaku', 校: 'kou', 大: 'dai', 小: 'shou', 中: 'naka',
  国: 'koku', 語: 'go',
  本: 'hon', 書: 'sho', 読: 'yomi', 聞: 'kiki', 話: 'hanashi', 言: 'ii', 声: 'koe',
  会: 'kai', 社: 'sha', 員: 'in', 店: 'mise', 屋: 'ya', 駅: 'eki', 空: 'sora',
  港: 'kou', 病: 'byou', 院: 'in', 銀: 'gin', 行: 'kou', 郵: 'yuu', 便: 'bin',
  局: 'kyoku', 図: 'to', 館: 'kan', 公: 'kou', 園: 'en', 室: 'shitsu', 部: 'bu',
  道: 'michi', 町: 'machi', 市: 'shi', 村: 'mura', 県: 'ken', 都: 'to', 府: 'fu',
  山: 'yama', 川: 'kawa', 海: 'umi', 天: 'ten', 気: 'ki', 雨: 'ame',
  雪: 'yuki', 風: 'kaze', 花: 'hana', 草: 'kusa', 犬: 'inu', 猫: 'neko', 鳥: 'tori',
  魚: 'sakana', 肉: 'niku', 米: 'kome', 野: 'ya', 菜: 'sai', 果: 'ka', 物: 'mono',
  食: 'shoku', 飲: 'nomi', 料: 'ryou', 理: 'ri', 茶: 'cha', 酒: 'sake', 塩: 'shio',
  車: 'kuruma', 電: 'den', 地: 'chi', 鉄: 'tetsu', 新: 'shin', 幹: 'kan', 線: 'sen',
  飛: 'hi', 機: 'ki', 自: 'ji', 転: 'ten', 動: 'dou', 切: 'kiri', 符: 'fu',
  見: 'mi', 来: 'ki', 帰: 'kaeri', 出: 'de', 入: 'hairi', 立: 'tachi', 座: 'suwari',
  歩: 'aruki', 走: 'hashiri', 泳: 'oyogi', 遊: 'asobi', 休: 'yasumi', 働: 'hataraki',
  買: 'kai', 売: 'uri', 使: 'tsukai', 作: 'tsukuri', 待: 'machi', 持: 'mochi',
  知: 'shiri', 思: 'omoi', 教: 'oshie', 習: 'narai', 勉: 'ben', 強: 'kyou',
  住: 'sumi', 起: 'oki', 寝: 'ne', 笑: 'warai', 泣: 'naki', 開: 'aki', 閉: 'shime',
  上: 'ue', 下: 'shita', 左: 'hidari', 右: 'migi', 外: 'soto', 内: 'uchi',
  東: 'higashi', 西: 'nishi', 南: 'minami', 北: 'kita', 近: 'chika', 遠: 'too',
  間: 'aida', 隣: 'tonari', 横: 'yoko', 側: 'gawa',
  高: 'taka', 安: 'yasu', 低: 'hiku', 長: 'naga', 短: 'mijika', 広: 'hiro',
  古: 'furu', 若: 'waka', 早: 'haya', 速: 'haya', 遅: 'oso', 多: 'oo', 少: 'suku',
  暑: 'atsu', 寒: 'samu', 熱: 'atsu', 冷: 'tsume', 暖: 'atata', 涼: 'suzu',
  良: 'yo', 悪: 'waru', 楽: 'tano', 苦: 'kuru', 難: 'muzuka', 易: 'yasa',
  面: 'omo', 白: 'shiro', 黒: 'kuro', 赤: 'aka', 青: 'ao', 黄: 'ki', 色: 'iro',
  美: 'bi', 味: 'aji', 好: 'su', 嫌: 'kira', 元: 'gen', 静: 'shizu', 有: 'yuu',
  名: 'na', 利: 'ri',
  数: 'kazu', 一: 'ichi', 二: 'ni', 三: 'san', 四: 'yon', 五: 'go', 六: 'roku',
  七: 'nana', 八: 'hachi', 九: 'kyuu', 十: 'juu', 百: 'hyaku', 千: 'sen', 万: 'man',
  円: 'en', 度: 'do', 回: 'kai', 番: 'ban', 台: 'dai', 冊: 'satsu', 匹: 'hiki',
  歳: 'sai', 才: 'sai', 何: 'nani', 誰: 'dare', 処: 'ko', 故: 'yue', 方: 'kata', 事: 'koto',
  仕: 'shi', 手: 'te', 足: 'ashi', 目: 'me', 耳: 'mimi', 口: 'kuchi', 頭: 'atama',
  体: 'karada', 心: 'kokoro', 力: 'chikara', 顔: 'kao', 髪: 'kami',
  服: 'fuku', 靴: 'kutsu', 帽: 'bou', 傘: 'kasa', 鞄: 'kaban', 財: 'zai', 布: 'fu',
  紙: 'kami', 鉛: 'en', 筆: 'hitsu', 辞: 'ji', 机: 'tsukue', 椅: 'i', 窓: 'mado',
  鍵: 'kagi', 写: 'sha', 真: 'shin', 音: 'oto', 映: 'ei', 画: 'ga',
  漢: 'kan', 字: 'ji', 文: 'bun', 法: 'hou', 単: 'tan', 質: 'shitsu', 問: 'mon',
  答: 'kotae', 宿: 'shuku', 題: 'dai', 試: 'shi', 験: 'ken', 練: 'ren',
  意: 'i', 発: 'hatsu', 英: 'ei', 訳: 'yaku', 説: 'setsu',
  最: 'sai', 初: 'hatsu', 終: 'owa', 始: 'haji', 続: 'tsuzu', 次: 'tsugi',
  同: 'ona', 違: 'chiga', 別: 'betsu', 全: 'zen', 以: 'i',
  実: 'jitsu', 感: 'kan', 考: 'kanga', 覚: 'obo', 忘: 'wasu', 決: 'ki',
  必: 'kanara', 要: 'you', 用: 'you', 可: 'ka', 能: 'nou', 不: 'fu', 無: 'mu',
  和: 'wa', 洋: 'you', 京: 'kyou', 阪: 'saka',
  誕: 'tan', 祝: 'iwa', 祭: 'matsuri', 神: 'kami', 寺: 'tera', 宮: 'miya', 薬: 'kusuri', 痛: 'ita', 医: 'i', 者: 'sha', 護: 'go', 職: 'shoku', 業: 'gyou', 産: 'san', 品: 'hin', 商: 'shou',
  価: 'ka', 格: 'kaku', 費: 'hi', 払: 'hara', 貸: 'ka',
  借: 'kari', 送: 'oku', 受: 'u', 取: 'to', 返: 'kae', 届: 'todo',
  乗: 'no', 降: 'o', 着: 'tsu', 止: 'to', 進: 'susu',
  探: 'saga', 選: 'era', 集: 'atsu',
  卵: 'tamago', 砂: 'suna', 糖: 'tou', 弁: 'ben', 当: 'tou', 喫: 'kitsu',
  堂: 'dou', 台: 'dai', 所: 'sho', 務: 'mu',
  雑: 'zatsu', 誌: 'shi',
  荷: 'ni', 世: 'se', 界: 'kai', 容: 'you',
  牛: 'ushi', 乳: 'nyuu', 鶏: 'niwatori', 豚: 'buta', 羊: 'hitsuji', 皆: 'mina', 個: 'ko', 枚: 'mai',
});

/**
 * Okurigana stems: the reading of a kanji when it is immediately followed by
 * hiragana that completes the word (verbs and い-adjectives, mostly).
 *
 * This is what turns 行きました into "ikimashita" instead of "kou kimashita" —
 * the stem is glued to the converted kana run with no space between them.
 */
const KANJI_STEMS = Object.freeze({
  // Verbs
  行: 'i', 来: 'ki', 帰: 'kae', 食: 'ta', 飲: 'no', 見: 'mi', 聞: 'ki',
  話: 'hana', 読: 'yo', 書: 'ka', 買: 'ka', 使: 'tsuka', 作: 'tsuku',
  待: 'ma', 分: 'wa', 知: 'shi', 出: 'de', 入: 'hai', 起: 'o', 寝: 'ne',
  働: 'hatara', 休: 'yasu', 教: 'oshi', 習: 'nara', 会: 'a', 持: 'mo',
  住: 'su', 思: 'omo', 言: 'i', 立: 'ta', 座: 'suwa', 歩: 'aru',
  走: 'hashi', 泳: 'oyo', 遊: 'aso', 笑: 'wara', 泣: 'na', 開: 'a',
  閉: 'shi', 始: 'haji', 終: 'o', 続: 'tsuzu', 送: 'oku', 受: 'u',
  取: 'to', 返: 'kae', 届: 'todo', 乗: 'no', 降: 'o', 着: 'tsu',
  止: 'to', 進: 'susu', 探: 'saga', 選: 'era', 集: 'atsu', 貸: 'ka',
  借: 'ka', 払: 'hara', 覚: 'obo', 忘: 'wasu', 決: 'ki', 考: 'kanga',
  答: 'kota', 洗: 'ara', 掛: 'ka', 置: 'o', 消: 'ke',
  付: 'tsu', 呼: 'yo', 歌: 'uta', 踊: 'odo', 描: 'ka', 手伝: 'tetsuda',
  // い-adjectives and adjectival stems
  大: 'oo', 小: 'chii', 新: 'atara', 古: 'furu', 高: 'taka', 安: 'yasu',
  低: 'hiku', 長: 'naga', 短: 'mijika', 良: 'yo', 悪: 'waru', 暑: 'atsu',
  寒: 'samu', 熱: 'atsu', 冷: 'tsume', 多: 'oo', 少: 'suku',
  難: 'muzuka', 易: 'yasa', 楽: 'tano', 忙: 'isoga', 広: 'hiro',
  若: 'waka', 苦: 'kuru', 強: 'tsuyo', 弱: 'yowa', 近: 'chika',
  遠: 'too', 暖: 'atata', 涼: 'suzu', 汚: 'kitana', 明: 'aka',
  暗: 'kura', 重: 'omo', 軽: 'karu', 太: 'futo', 細: 'hoso',
  甘: 'ama', 辛: 'kara', 早: 'haya', 速: 'haya', 遅: 'oso',
  面白: 'omoshiro', 美味: 'oi',
});

// ---------------------------------------------------------------------------
// 3. Character helpers
// ---------------------------------------------------------------------------

const KATAKANA_START = 0x30a1;
const KATAKANA_END = 0x30f6;
const HIRAGANA_OFFSET = 0x30a1 - 0x3041;

/** @param {string} char */
function isKatakana(char) {
  const code = char.codePointAt(0) ?? 0;
  return code >= KATAKANA_START && code <= KATAKANA_END;
}

/** @param {string} char */
function isHiragana(char) {
  const code = char.codePointAt(0) ?? 0;
  return code >= 0x3041 && code <= 0x3096;
}

/** @param {string} char */
function isKanji(char) {
  const code = char.codePointAt(0) ?? 0;
  return (
    (code >= 0x4e00 && code <= 0x9fff) || // CJK Unified Ideographs
    (code >= 0x3400 && code <= 0x4dbf) || // Extension A
    code === 0x3005 // 々 iteration mark
  );
}

/**
 * True when the string contains any Japanese script at all.
 * @param {unknown} text
 * @returns {boolean}
 */
export function containsJapanese(text) {
  if (typeof text !== 'string') return false;
  for (const char of text) {
    if (isKanji(char) || isHiragana(char) || isKatakana(char)) return true;
  }
  return false;
}

/** Convert katakana characters to their hiragana equivalents. */
function katakanaToHiragana(text) {
  let out = '';
  for (const char of text) {
    if (isKatakana(char)) {
      out += String.fromCodePoint((char.codePointAt(0) ?? 0) - HIRAGANA_OFFSET);
    } else if (char === 'ヷ') {
      out += 'ゔぁ';
    } else if (char === 'ヺ') {
      out += 'ゔぉ';
    } else {
      out += char;
    }
  }
  return out;
}

/** Full-width ASCII (Ａ-Ｚ ａ-ｚ ０-９) to half-width. */
function normalizeFullWidth(text) {
  return text.replace(/[！-～]/g, (char) =>
    String.fromCharCode((char.charCodeAt(0) ?? 0) - 0xfee0),
  );
}

// ---------------------------------------------------------------------------
// 4. Kana run -> romaji
// ---------------------------------------------------------------------------

const VOWELS = new Set(['a', 'i', 'u', 'e', 'o']);

/**
 * Convert a run of hiragana (katakana already folded in) to romaji.
 * @param {string} kana
 * @returns {string}
 */
function kanaRunToRomaji(kana) {
  let out = '';
  let index = 0;

  while (index < kana.length) {
    const char = kana[index];
    const pair = kana.slice(index, index + 2);

    // --- Digraph (きゃ, しゅ, ...) ---------------------------------------
    if (DIGRAPHS[pair]) {
      out += DIGRAPHS[pair];
      index += 2;
      continue;
    }

    // --- Sokuon: っ doubles the following consonant ------------------------
    if (char === 'っ') {
      const nextPair = kana.slice(index + 1, index + 3);
      const nextChar = kana[index + 1];
      const nextRomaji = DIGRAPHS[nextPair] || (nextChar ? KANA[nextChar] : '');
      if (nextRomaji) {
        // "chi" geminates as "tchi"; everything else doubles its first letter.
        out += nextRomaji.startsWith('ch') ? 't' : nextRomaji[0];
      } else {
        out += '';
      }
      index += 1;
      continue;
    }

    // --- Chōonpu: ー lengthens the previous vowel --------------------------
    if (char === 'ー' || char === '－') {
      const previous = out[out.length - 1];
      if (previous && VOWELS.has(previous)) out += previous;
      index += 1;
      continue;
    }

    // --- ん: needs an apostrophe before a vowel or y ------------------------
    if (char === 'ん') {
      const nextPair = kana.slice(index + 1, index + 3);
      const nextChar = kana[index + 1];
      const nextRomaji = DIGRAPHS[nextPair] || (nextChar ? KANA[nextChar] : '');
      out += 'n';
      if (nextRomaji && (VOWELS.has(nextRomaji[0]) || nextRomaji[0] === 'y')) {
        out += "'";
      }
      index += 1;
      continue;
    }

    // --- を is always the object particle: read "o", set off by spaces -----
    if (char === 'を') {
      out += `${out && !/\s$/.test(out) ? ' ' : ''}o `;
      index += 1;
      continue;
    }

    // --- Plain kana --------------------------------------------------------
    if (KANA[char] !== undefined) {
      out += KANA[char];
      index += 1;
      continue;
    }

    // Not kana — caller should not have passed it, but never drop into script.
    out += char;
    index += 1;
  }

  return out;
}

/** Collapse おう/おお -> ō-style "ou"/"oo" is kept as-is (Hepburn-with-vowels). */
function tidySpacing(text) {
  return text
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([.,!?;:])/g, '$1')
    .replace(/^\s+|\s+$/g, '');
}

// ---------------------------------------------------------------------------
// 5. Main conversion
// ---------------------------------------------------------------------------

/** Dictionary keys sorted longest-first so longer words win. */
const WORD_KEYS_SORTED = Object.keys(WORDS)
  .filter((key) => WORDS[key] && containsJapanese(key))
  .sort((a, b) => b.length - a.length);

const MAX_WORD_LENGTH = WORD_KEYS_SORTED.length ? WORD_KEYS_SORTED[0].length : 0;

/**
 * Convert Japanese text to Romaji for display.
 *
 * Best effort by design: unreadable kanji become `[?]` rather than being shown
 * in native script, because the visible conversation UI must never contain
 * Japanese characters for a Japanese profile.
 *
 * @param {unknown} input
 * @returns {string}
 */
export function toRomaji(input) {
  if (typeof input !== 'string' || !input) return typeof input === 'string' ? input : '';

  const text = katakanaToHiragana(normalizeFullWidth(input));

  /** @type {string[]} */
  const tokens = [];

  /** Append a token, letting tidySpacing sort out the joins later. */
  const push = (token) => {
    if (token) tokens.push(token);
  };

  let index = 0;
  /**
   * True when the token just emitted came from a kanji (a dictionary word or a
   * lone character). Only in that position can は/へ be grammatical particles;
   * inside a kana word they keep their literal "ha"/"he" readings.
   */
  let afterKanjiToken = false;
  /** True when the token just emitted was Latin text: "Murasaki noはいらない". */
  let afterLatin = false;

  /** End index of the hiragana run starting at `start`. */
  const kanaRunEnd = (start) => {
    let end = start;
    while (
      end < text.length &&
      (isHiragana(text[end]) || text[end] === 'ー' || text[end] === 'ｰ')
    ) {
      end += 1;
    }
    return end;
  };

  while (index < text.length) {
    const char = text[index];

    // --- 1. Particle は / へ directly after a kanji-derived word -----------
    if (afterKanjiToken && (char === 'は' || char === 'へ')) {
      // Only when it really is standing alone: the next character must not
      // continue a kana word (e.g. 私はしる vs 私は しる is ambiguous, but a
      // following kana that begins a known word is the common case, so we
      // accept the particle reading here — it is right far more often).
      push(PARTICLE_READINGS[char]);
      index += 1;
      afterKanjiToken = false;
      afterLatin = false;
      continue;
    }

    // --- 2. Longest dictionary match --------------------------------------
    let matched = false;
    const maxLen = Math.min(MAX_WORD_LENGTH, text.length - index);
    for (let length = maxLen; length >= 1; length -= 1) {
      const slice = text.slice(index, index + length);
      const reading = WORDS[slice];
      if (reading) {
        push(reading);
        index += length;
        matched = true;
        // Particles may follow a kanji word, but not a purely kana phrase such
        // as こんにちは (whose trailing は is already part of the reading).
        afterKanjiToken = [...slice].some(isKanji);
        afterLatin = false;
        break;
      }
    }
    if (matched) continue;

    // --- 3. Kanji ------------------------------------------------------------
    if (isKanji(char)) {
      // 3a. Kanji + okurigana: glue the stem to the following kana run so
      //     行きました reads "ikimashita", not "kou kimashita".
      const twoCharStem = KANJI_STEMS[text.slice(index, index + 2)];
      const oneCharStem = KANJI_STEMS[char];
      const stemLength = twoCharStem ? 2 : 1;
      const stem = twoCharStem || oneCharStem;

      if (stem && isHiragana(text[index + stemLength])) {
        const end = kanaRunEnd(index + stemLength);
        push(stem + kanaRunToRomaji(text.slice(index + stemLength, end)));
        index = end;
        afterKanjiToken = false;
        continue;
      }

      // 3b. Lone kanji: use a per-character reading, or a visible placeholder.
      push(KANJI_CHARS[char] || UNKNOWN);
      index += 1;
      afterKanjiToken = true;
      afterLatin = false;
      continue;
    }

    // --- 4. Kana run --------------------------------------------------------
    // 4a. は as a particle where a transcript leaves it inside a kana run: after
    //     の, に, で or と ("黄色のはいらないです" read "kiiro nohairanaidesu"),
    //     or straight after Latin letters ("Murasaki noはいらないです").
    if (/^[のにでと]は/.test(text.slice(index, index + 2)) || (char === 'は' && afterLatin)) {
      if (char !== 'は') push(kanaRunToRomaji(char));
      push(PARTICLE_READINGS['は']);
      index += char === 'は' ? 1 : 2;
      afterKanjiToken = false;
      afterLatin = false;
      continue;
    }
    if (isHiragana(char) || char === 'ー' || char === 'ｰ') {
      const end = kanaRunEnd(index);
      push(kanaRunToRomaji(text.slice(index, end)));
      index = end;
      afterKanjiToken = false;
      afterLatin = false;
      continue;
    }

    // --- 5. Punctuation ------------------------------------------------------
    if (PUNCTUATION[char] !== undefined) {
      push(PUNCTUATION[char]);
      index += 1;
      afterKanjiToken = false;
      afterLatin = false;
      continue;
    }

    // --- 6. Anything else (Latin text, digits, spaces) passes through --------
    //        Consumed as a whole run so "Hello there" does not become
    //        "H e l l o  t h e r e".
    let end = index;
    while (
      end < text.length &&
      !isKanji(text[end]) &&
      !isHiragana(text[end]) &&
      text[end] !== 'ー' &&
      text[end] !== 'ｰ' &&
      PUNCTUATION[text[end]] === undefined
    ) {
      end += 1;
    }
    push(text.slice(index, end));
    afterLatin = /[A-Za-z]s*$/.test(text.slice(index, end));
    index = end;
    afterKanjiToken = false;
  }

  let out = tokens.join(' ');

  // Punctuation should hug the word before it.
  out = out.replace(/\s+([.,!?;:)\]}"])/g, '$1').replace(/([(\[{"])\s+/g, '$1');

  // Split the trailing question particle: "desuka" -> "desu ka".
  out = out.replace(/\b(desu|masu|deshita|mashita|masen|deshou|mashou)(ka|ne|yo)\b/g, '$1 $2');

  // --- Final safety net: nothing Japanese may survive ----------------------
  out = out.replace(/[぀-ヿ㐀-䶿一-鿿ｦ-ﾟ]+/g, UNKNOWN);

  return tidySpacing(out);
}

/**
 * Convert text for display in a given language profile.
 * Japanese is romanised; Roman-alphabet languages pass through untouched.
 *
 * @param {unknown} text
 * @param {string} language
 * @returns {string}
 */
export function toDisplayText(text, language) {
  const value = typeof text === 'string' ? text : '';
  const isJapanese =
    typeof language === 'string' && language.trim().toLowerCase() === 'japanese';
  if (!isJapanese) return value;
  return containsJapanese(value) ? toRomaji(value) : value;
}
