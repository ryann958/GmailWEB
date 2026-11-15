import { randomInt } from "node:crypto";

const GENERATION_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const GENERATION_DIGITS = "0123456789";
const GENERATION_ALPHABET = `${GENERATION_LETTERS}${GENERATION_DIGITS}`;
export const GENERATED_TEXT_LENGTH = 20;
export const GENERATED_TEXT_SUFFIX = "@ryann.com";
export const GENERATED_TEXT_PATTERN = /^[A-Za-z0-9]{20}@ryann\.com$/;

export function generateRandomText() {
  const characters = [
    GENERATION_LETTERS[randomInt(GENERATION_LETTERS.length)],
    GENERATION_DIGITS[randomInt(GENERATION_DIGITS.length)],
  ];
  while (characters.length < GENERATED_TEXT_LENGTH) {
    characters.push(GENERATION_ALPHABET[randomInt(GENERATION_ALPHABET.length)]);
  }
  for (let index = characters.length - 1; index > 0; index -= 1) {
    const swapIndex = randomInt(index + 1);
    [characters[index], characters[swapIndex]] = [characters[swapIndex], characters[index]];
  }
  return `${characters.join("")}${GENERATED_TEXT_SUFFIX}`;
}
