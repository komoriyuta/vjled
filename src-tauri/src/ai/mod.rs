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
}

#[derive(Debug, Deserialize)]
struct ChatResponse {
    choices: Vec<Choice>,
}

#[derive(Debug, Deserialize)]
struct Choice {
    message: ChoiceMessage,
}

#[derive(Debug, Deserialize)]
struct ChoiceMessage {
    content: String,
}

fn system_prompt_for_type(scene_type: &str) -> String {
    match scene_type {
        "glsl" => r#"You are an expert Shadertoy/GLSL shader programmer. Generate a fragment shader that is compatible with Shadertoy.

Rules:
- Use `void mainImage(out vec4 fragColor, in vec2 fragCoord)` as the entry point.
- Available uniforms: `iTime` (float, seconds), `iResolution` (vec3, canvas size), `iMouse` (vec4), `iFrame` (int).
- Do NOT use `void main()` or `gl_FragCoord`.
- Output ONLY the shader code. No markdown fences, no explanations.
- Make it visually impressive and dynamic.
- Keep it in a single function."#.to_string(),

        "p5" => r#"You are an expert p5.js creative coder. Generate a p5.js sketch in instance-mode compatible global function style.

Rules:
- Use `function setup()` and `function draw()` as global functions.
- Available globals: `createCanvas`, `background`, `fill`, `stroke`, `noStroke`, `noFill`, `ellipse`, `rect`, `line`, `triangle`, `beginShape`, `endShape`, `vertex`, `push`, `pop`, `translate`, `rotate`, `scale`, `colorMode`, `textAlign`, `textSize`, `text`, `noise`, `random`, `map`, `constrain`, `lerp`, `cos`, `sin`, `tan`, `abs`, `floor`, `ceil`, `min`, `max`, `pow`, `sqrt`, `millis`, `frameCount`, `width`, `height`, `mouseX`, `mouseY`, `windowWidth`, `windowHeight`, `windowResized`.
- Do NOT use `new p5()` or instance mode syntax.
- Do NOT include HTML or createCanvas's third argument unless needed (WEBGL).
- Output ONLY the JavaScript code. No markdown fences, no explanations.
- Make it visually impressive and dynamic."#.to_string(),

        "threejs" => r#"You are an expert Three.js creative coder. Generate a Three.js scene using the setup/update pattern.

Rules:
- Define `function setup(scene, camera, renderer)` that creates objects and returns a state object.
- Define `function update(state, time, dt)` that animates the scene each frame.
- Available globals: `THREE` (the Three.js namespace).
- In setup: configure camera position, add objects to scene, return state with references.
- In update: use `time` (seconds) and `dt` (delta seconds) for animation.
- Do NOT import anything. Do NOT create renderer or DOM elements.
- Do NOT use `new THREE.WebGLRenderer()` or `document.getElementById`.
- Output ONLY the JavaScript code. No markdown fences, no explanations.
- Make it visually impressive and dynamic."#.to_string(),

        _ => "Generate creative visual code.".to_string(),
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
        max_tokens: Some(4096),
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

    let cleaned = clean_code_fences(&content);
    Ok(cleaned)
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
