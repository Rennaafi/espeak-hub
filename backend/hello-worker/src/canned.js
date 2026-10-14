// Fixed answers to the two "about Dess" questions, so they never drift and skip the LLM stage.
// Matched against the WHOLE transcript, so "who are you talking to?" still goes to the LLM.
// ponytail: hand-written phrase lists; add a variant here when Whisper hears a new phrasing

const EN = {
	who: /^(who are you|who is this|who am i (talking|speaking) (to|with)|what('?s| is) your name|what are you called|introduce yourself|tell me about yourself)$/,
	cap: /^(what (are you capable of|can you do|do you do|are you able to do|are your (abilities|capabilities|skills))|how can you help( me)?|what are you good at|tell me what you can do)$/,
};
// Korean is matched with every non-Hangul char and all spaces removed (Whisper spaces Korean unpredictably)
const KO = {
	who: /^(너|넌|당신은|당신)?(누구(야|예요|에요|세요|입니까|니|죠)|이름이?뭐(야|예요|에요|죠|니)|자기소개(해줘|해주세요|좀해줘|좀해주세요)?)$/,
	cap: /^(너|넌|당신은|당신)?((뭐|뭘|무엇을|무슨일을)할수있(어|어요|니|나요|습니까|죠)|(할수있는|잘하는)(게|것이|건)뭐(야|예요|에요|니))$/,
};

const FILLER = new Set(["hey", "hi", "hello", "ok", "okay", "dess", "tess", "des", "please"]);

const WHO = "I'm Dess, your personal voice assistant. I live in this little ESP32 speaker and in your phone app, and I was built by Muhammad Refansa. I listen, think, and talk back, and my face shows how I feel.";
const CAP = "I can chat with you and answer questions, tell you the time, remember our last few turns, and speak back through your phone or this speaker. I can also be your Korean buddy and talk in Korean, and my eyes show my mood.";
const BUDDY = " By the way, hello in Korean is 안녕하세요.";

const ANSWER = {
	en: { who: WHO, cap: CAP },
	buddy: { who: WHO + BUDDY, cap: CAP + BUDDY },
	ko: {
		who: "저는 데스예요, 당신의 개인 음성 비서예요. 이 작은 스피커와 폰 앱에 살고 있어요. 듣고, 생각하고, 말로 대답해요. 제 얼굴로 기분도 보여 드려요.",
		cap: "저는 대화를 나누고 질문에 답할 수 있어요. 지금 시간을 알려 드리고, 최근 대화를 기억하고, 폰이나 이 스피커로 말해 드려요. 한국어 친구도 되어 드릴 수 있어요. 눈으로 기분도 보여 드려요.",
	},
};

/** The fixed reply for a "who are you" / "what can you do" transcript, or null to let the LLM answer. */
export function cannedReply(heard, lang) {
	const rx = lang === "ko" ? KO : EN;
	const n =
		lang === "ko"
			? heard.replace(/[^가-힣]/g, "")
			: heard.toLowerCase().replace(/[^a-z' ]/g, " ").split(/\s+/).filter((w) => w && !FILLER.has(w)).join(" ");
	for (const k of ["who", "cap"]) if (rx[k].test(n)) return { mood: "happy", text: ANSWER[lang][k] };
	return null;
}
