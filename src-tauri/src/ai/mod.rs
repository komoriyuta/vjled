use reqwest::Client;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Serialize)]
struct ChatRequest {
    model: String,
    messages: Vec<ChatMessage>,
    temperature: f32,
    #[serde(skip_serializing_if = "Option::is_none")]
    max_tokens: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    response_format: Option<ResponseFormat>,
}

#[derive(Debug, Serialize)]
struct ResponseFormat {
    #[serde(rename = "type")]
    kind: String,
}

#[derive(Debug, Deserialize)]
struct ChatResponse {
    choices: Vec<Choice>,
}

#[derive(Debug, Deserialize)]
struct Choice {
    message: ChoiceMessage,
    finish_reason: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ChoiceMessage {
    content: String,
}

#[derive(Debug, Deserialize)]
struct GeneratedCodeResponse {
    code: String,
    complete: bool,
}

fn system_prompt_for_type(scene_type: &str) -> String {
    match scene_type {
        "glsl" => r#"You are an expert Shadertoy/GLSL shader programmer. Generate a fragment shader that is compatible with Shadertoy.

Rules:
- Use `void mainImage(out vec4 fragColor, in vec2 fragCoord)` as the entry point.
- Available uniforms: `iTime` (float, seconds), `iResolution` (vec2, canvas size), `iMouse` (vec4), `iFrame` (int).
- Available audio uniforms: `iBpm`, `iBeat`, `iBeatPhase`, `iBeatCount`, `iFft[32]`.
- Available helper: `float fftAt(float index)` for variable FFT access inside loops.
- Do NOT declare uniforms. The renderer already declares all uniforms and helpers.
- Do NOT declare `precision`; the renderer already injects it.
- Do NOT use `void main()` or `gl_FragCoord`.
- Do NOT dynamically index `iFft`; `iFft[0]`, `iFft[8]`, `iFft[16]`, `iFft[24]` are OK, but `iFft[i]`, `iFft[int(x)]`, and `iFft[idx]` are forbidden.
- In loops, use `fftAt(float(i))` or `fftAt(mod(value, 32.0))`.
- Use only WebGL 1 / GLSL ES 1.00 compatible syntax. No arrays of structs, no texture functions, no non-constant loop bounds.
- Keep loops bounded by literal constants such as `for (int i = 0; i < 48; i++)`.
- Avoid nested loops unless absolutely necessary; prefer one loop with literal bounds.
- Avoid `if` branches based on tiny beat windows when a `step`/`smoothstep` expression can do the same.
- Make it visually impressive and dynamic.
- Keep it in a single function.

Output format:
- Return ONLY valid JSON: {"code":"...","complete":true}
- Put the entire shader source in `code`.
- Set `complete` to true only when the code is fully finished and syntactically closed.
- Do not include markdown fences, explanations, or partial code."#.to_string(),

        "p5" => r#"You are an expert p5.js creative coder. Generate a p5.js sketch in instance-mode compatible global function style.

Rules:
- Use `function setup()` and `function draw()` as global functions.
- Available globals: `createCanvas`, `background`, `fill`, `stroke`, `noStroke`, `noFill`, `ellipse`, `rect`, `line`, `triangle`, `beginShape`, `endShape`, `vertex`, `push`, `pop`, `translate`, `rotate`, `scale`, `colorMode`, `textAlign`, `textSize`, `text`, `noise`, `random`, `map`, `constrain`, `lerp`, `cos`, `sin`, `tan`, `abs`, `floor`, `ceil`, `min`, `max`, `pow`, `sqrt`, `millis`, `frameCount`, `width`, `height`, `mouseX`, `mouseY`, `windowWidth`, `windowHeight`, `windowResized`.
- Available audio globals: `audio`, `bpm`, `beat`, `beatPhase`, `beatCount`, `fft`.
- Must define both `function setup()` and `function draw()`.
- Do NOT use `new p5()` or instance mode syntax.
- Do NOT include HTML or createCanvas's third argument unless needed (WEBGL).
- Do NOT use imports, exports, `document`, or external assets.
- Make it visually impressive and dynamic.

Output format:
- Return ONLY valid JSON: {"code":"...","complete":true}
- Put the entire JavaScript source in `code`.
- Set `complete` to true only when the code is fully finished and syntactically closed.
- Do not include markdown fences, explanations, or partial code."#.to_string(),

        "threejs" => r#"You are an expert Three.js creative coder. Generate a Three.js scene using the setup/update pattern.

Rules:
- Define `function setup(scene, camera, renderer)` that creates objects and returns a state object.
- Define `function update(state, time, dt, audio)` that animates the scene each frame.
- Available globals: `THREE` (the Three.js namespace).
- Audio includes: `audio.bpm`, `audio.beat`, `audio.beatPhase`, `audio.beatCount`, `audio.fft`, `audio.genre`.
- In setup: configure camera position, add objects to scene, return state with references.
- In update: use `time` (seconds) and `dt` (delta seconds) for animation.
- Do NOT import anything. Do NOT create renderer or DOM elements.
- Do NOT use `new THREE.WebGLRenderer()` or `document.getElementById`.
- Do NOT use loaders, fetch, external textures, external models, or async code.
- Make it visually impressive and dynamic.

Output format:
- Return ONLY valid JSON: {"code":"...","complete":true}
- Put the entire JavaScript source in `code`.
- Set `complete` to true only when the code is fully finished and syntactically closed.
- Do not include markdown fences, explanations, or partial code."#.to_string(),

        _ => r#"Generate creative visual code.

Output format:
- Return ONLY valid JSON: {"code":"...","complete":true}
- Put the entire source in `code`.
- Set `complete` to true only when the code is fully finished and syntactically closed.
- Do not include markdown fences, explanations, or partial code."#.to_string(),
    }
}

pub async fn generate_code(
    base_url: &str,
    api_key: &str,
    model: &str,
    scene_type: &str,
    user_prompt: &str,
    existing_code: Option<&str>,
) -> Result<String, String> {
    let client = Client::new();
    let url = format!(
        "{}/chat/completions",
        base_url.trim_end_matches('/').trim_end_matches("/v1")
    );
    let url = if url.ends_with("/chat/completions") {
        url
    } else {
        format!("{}/v1/chat/completions", base_url.trim_end_matches('/'))
    };

    let system = system_prompt_for_type(scene_type);

    let mut messages = vec![
        ChatMessage {
            role: "system".to_string(),
            content: system,
        },
    ];

    if let Some(code) = existing_code {
        if !code.is_empty() {
            messages.push(ChatMessage {
                role: "user".to_string(),
                content: format!("Here is my current code:\n\n```\n{}\n```", code),
            });
            messages.push(ChatMessage {
                role: "assistant".to_string(),
                content: "I understand your current code. What changes would you like?".to_string(),
            });
        }
    }

    messages.push(ChatMessage {
        role: "user".to_string(),
        content: user_prompt.to_string(),
    });

    let body = ChatRequest {
        model: model.to_string(),
        messages,
        temperature: 0.8,
        max_tokens: Some(32768),
        response_format: Some(ResponseFormat {
            kind: "json_object".to_string(),
        }),
    };

    let response = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", api_key))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        return Err(format!("API error ({}): {}", status, text));
    }

    let chat_resp: ChatResponse = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse response: {}", e))?;

    let choice = chat_resp
        .choices
        .first()
        .ok_or("No response from API")?;

    if choice.finish_reason.as_deref() == Some("length") {
        return Err("AI response was truncated before a complete JSON/code result was returned".to_string());
    }

    parse_generated_code_json(scene_type, &choice.message.content)
}

pub async fn decide_auto_vj(
    base_url: &str,
    api_key: &str,
    model: &str,
    user_prompt: &str,
) -> Result<String, String> {
    let client = Client::new();
    let url = format!(
        "{}/chat/completions",
        base_url.trim_end_matches('/').trim_end_matches("/v1")
    );
    let url = if url.ends_with("/chat/completions") {
        url
    } else {
        format!("{}/v1/chat/completions", base_url.trim_end_matches('/'))
    };

    let messages = vec![
        ChatMessage {
            role: "system".to_string(),
            content: r#"You are a live VJ director. Decide whether the visuals should stay stable, receive a small transition accent, switch to an existing scene, or generate a new scene.

Return ONLY compact JSON with this shape:
{"action":"KEEP|ACCENT|SWITCH|GENERATE","confidence":0.0,"reason":"short reason","targetSceneId":"optional scene id","visualDirection":"optional concise direction"}

Rules:
- Prefer KEEP when the music state is stable or the current scene is still fresh.
- Prefer ACCENT for beat/drop/energy changes that do not need new code.
- Prefer SWITCH when an existing scene matches the current music better.
- Use GENERATE when the current scene is old, generation cooldown has elapsed, and no existing non-paused scene fits.
- Do not include markdown, prose, code fences, or extra text. The first character must be `{` and the last character must be `}`."#.to_string(),
        },
        ChatMessage {
            role: "user".to_string(),
            content: user_prompt.to_string(),
        },
    ];

    let body = ChatRequest {
        model: model.to_string(),
        messages,
        temperature: 0.2,
        max_tokens: Some(8192),
        response_format: Some(ResponseFormat {
            kind: "json_object".to_string(),
        }),
    };

    let response = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", api_key))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        return Err(format!("API error ({}): {}", status, text));
    }

    let chat_resp: ChatResponse = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse response: {}", e))?;

    let content = chat_resp
        .choices
        .first()
        .map(|c| c.message.content.clone())
        .ok_or("No response from API")?;

    Ok(clean_code_fences(&content))
}

fn parse_generated_code_json(scene_type: &str, content: &str) -> Result<String, String> {
    let json = extract_json_object(content)
        .ok_or("AI response did not contain a JSON object")?;
    let generated: GeneratedCodeResponse = serde_json::from_str(json)
        .map_err(|e| format!("AI response JSON parse failed: {}", e))?;
    if !generated.complete {
        return Err("AI reported that the generated code is incomplete".to_string());
    }
    let code = generated.code.trim();
    if code.is_empty() {
        return Err("AI returned an empty code field".to_string());
    }
    if code.contains("```") {
        return Err("AI returned markdown fences inside the code field".to_string());
    }
    validate_generated_code(scene_type, code)?;
    Ok(code.to_string())
}

fn validate_generated_code(scene_type: &str, code: &str) -> Result<(), String> {
    match scene_type {
        "glsl" => {
            if !code.contains("mainImage") {
                return Err("AI returned GLSL without mainImage".to_string());
            }
            if code.contains("uniform ") {
                return Err("AI returned GLSL with uniform declarations; uniforms are injected by the renderer".to_string());
            }
            if code.contains("precision ") {
                return Err("AI returned GLSL with a precision declaration; precision is injected by the renderer".to_string());
            }
            if code.contains("iFft[int(")
                || code.contains("iFft[i]")
                || code.contains("iFft[j]")
                || code.contains("iFft[k]")
                || code.contains("iFft[idx]")
                || code.contains("iFft[index]")
            {
                return Err("AI returned GLSL with dynamic iFft indexing; use fftAt(float) for variable FFT access".to_string());
            }
        }
        "p5" => {
            if !code.contains("function setup(") || !code.contains("function draw(") {
                return Err("AI returned p5 code without setup() and draw()".to_string());
            }
            if code.contains("new p5(")
                || code.contains("import ")
                || code.contains("export ")
                || code.contains("document.")
                || code.contains("window.")
                || code.contains("<script")
                || code.contains("<canvas")
            {
                return Err("AI returned p5 code outside the supported sandbox contract".to_string());
            }
        }
        "threejs" => {
            if !code.contains("function setup(scene, camera, renderer)") || !code.contains("function update(state, time, dt, audio)") {
                return Err("AI returned Three.js code without the required setup/update signatures".to_string());
            }
            if code.contains("import ")
                || code.contains("export ")
                || code.contains("document.")
                || code.contains("window.")
                || code.contains("fetch(")
                || code.contains("TextureLoader")
                || code.contains("GLTFLoader")
                || code.contains("new THREE.WebGLRenderer")
            {
                return Err("AI returned Three.js code outside the supported renderer contract".to_string());
            }
        }
        _ => {}
    }
    Ok(())
}

fn extract_json_object(content: &str) -> Option<&str> {
    let trimmed = content.trim();
    if trimmed.starts_with('{') && trimmed.ends_with('}') {
        return Some(trimmed);
    }
    let start = trimmed.find('{')?;
    let end = trimmed.rfind('}')?;
    if end <= start {
        return None;
    }
    Some(&trimmed[start..=end])
}

fn clean_code_fences(code: &str) -> String {
    let trimmed = code.trim();
    if trimmed.starts_with("```") {
        let without_start = trimmed.trim_start_matches("```")
            .trim_start_matches(|c: char| c.is_alphanumeric() || c == '\n' || c == '\r');
        let without_end = without_start.trim_end_matches("```").trim();
        without_end.to_string()
    } else {
        trimmed.to_string()
    }
}
