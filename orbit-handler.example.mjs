/** Replace this with the documented Orbit integration once its API is known.
 * payload: {kind, prompt, website, aspectRatio, references:[{role,asset}],
 *           audio, timing:{start,duration}, nodeId, projectRevision}
 * context: {jobId, baseUrl, downloadReference(asset): Buffer}
 * Return {filePath: absolute downloaded output path, mime: 'image/png'|'video/mp4'}.
 * Await the actual saved file. Do not return a placeholder or claim a result
 * before the website finishes. Stop for login/CAPTCHA/user confirmation.
 */
export async function runJob(payload, context) {
  throw new Error('Chưa cấu hình API Orbit và kịch bản website. Không mở profile hoặc gửi prompt.');
}
