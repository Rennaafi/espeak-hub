// Run: node test/canned_check.mjs   (no network; asserts which transcripts get the fixed answers)
import assert from "node:assert/strict";
import { cannedReply } from "../src/canned.js";

const is = (heard, lang, kind) => {
	const r = cannedReply(heard, lang);
	assert.ok(r, `expected a canned reply for [${lang}] "${heard}"`);
	assert.equal(r.mood, "happy");
	assert.ok(kind === "who" ? /Dess|데스예요/.test(r.text) : /chat|대화/.test(r.text), `wrong answer for "${heard}"`);
	return r;
};
const no = (heard, lang) => assert.equal(cannedReply(heard, lang), null, `should NOT match [${lang}] "${heard}"`);

for (const q of ["Who are you?", "Hey Dess, what's your name?", "Hello, who is this", "Introduce yourself.", "Tell me about yourself!", "What is your name, Dess?"]) is(q, "en", "who");
for (const q of ["What are you capable of?", "what can you do", "Dess, what can you do?", "What are your abilities?", "How can you help me?"]) is(q, "en", "cap");
for (const q of ["Who are you talking to?", "What are you doing?", "What is the capital city of Japan?", "Who are you going to vote for", "Tell me a fun fact about octopuses."]) no(q, "en");

assert.match(is("who are you", "buddy", "who").text, /안녕하세요/); // buddy adds a Korean greeting
assert.doesNotMatch(is("who are you", "en", "who").text, /안녕하세요/);

for (const q of ["너 누구야?", "넌 누구야", "누구세요", "이름이 뭐예요?", "너 이름이 뭐야", "자기소개 해 줘"]) is(q, "ko", "who");
for (const q of ["뭐 할 수 있어요?", "넌 뭘 할 수 있어?", "할 수 있는 게 뭐야", "무엇을 할 수 있니"]) is(q, "ko", "cap");
for (const q of ["안녕하세요, 오늘 기분이 어때요?", "오늘 날씨 어때요", "누구 만났어요?"]) no(q, "ko");
no("who are you", "ko"); // ko mode only matches Hangul

console.log("canned_check ok");
