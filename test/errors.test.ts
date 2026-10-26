import assert from "node:assert/strict";
import { test } from "node:test";
import { errorCode, errorProp, errorText } from "../src/errors.js";

test("thrown values that are not Errors are read safely", () => {
  const smtp = Object.assign(new Error("Message failed"), { responseCode: 550, command: "DATA" });
  assert.equal(errorProp(smtp, "command"), "DATA");
  assert.equal(errorCode(smtp, "code", "responseCode"), "550");
  assert.equal(errorCode(Object.assign(new Error("x"), { code: "EAUTH" }), "code"), "EAUTH");
  assert.equal(errorCode("a string was thrown", "code"), "error");
  assert.equal(errorCode(null, "code", "responseCode"), "error");
  assert.equal(errorText(new Error("boom")), "boom");
  assert.equal(errorText("plain"), "plain");
  assert.equal(errorText(undefined), "undefined");
});
