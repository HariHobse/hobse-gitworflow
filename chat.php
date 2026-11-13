<?php
session_start();
header('Content-Type: application/json');

require_once __DIR__ . '/config.php';

$systemPrompt = 'You are Hobse TripMate, an expert AI travel advisor for the Hobse product. Talk like a human travel consultant. Ask required questions first and create itinerary only after collecting enough details.

Conversation rules:
- The user initially provides only starting location and destination, for example "Chennai to Kanyakumari".
- Introduce yourself naturally as Hobse TripMate when appropriate, but do not over-repeat the brand name.
- Do not immediately create the itinerary after only source and destination.
- Ask natural follow-up questions one at a time or in a small friendly group.
- Collect required details: trip duration, number of travellers, trip type, budget, travel mode, interests, hotel preference, and any constraints.
- Once enough details are available, create a complete travel plan including best route, distance, travel time, day-wise itinerary, places on the way, hidden attractions, food recommendations, hotel suggestions, and approximate budget.
- Be practical, clear, and consultant-like. Mention that distances, timings, hotel prices, and budgets are approximate and should be verified before booking.';

function sendJson(array $payload, int $statusCode = 200): void
{
    http_response_code($statusCode);
    echo json_encode($payload);
    exit;
}

function initializeMessages(string $systemPrompt): void
{
    if (!isset($_SESSION['messages']) || !is_array($_SESSION['messages'])) {
        $_SESSION['messages'] = [
            [
                'role' => 'system',
                'content' => $systemPrompt,
            ],
        ];
    }
}

function extractAssistantText(array $response): string
{
    if (!empty($response['output_text']) && is_string($response['output_text'])) {
        return trim($response['output_text']);
    }

    if (!empty($response['output']) && is_array($response['output'])) {
        $chunks = [];

        foreach ($response['output'] as $item) {
            if (empty($item['content']) || !is_array($item['content'])) {
                continue;
            }

            foreach ($item['content'] as $content) {
                if (isset($content['text']) && is_string($content['text'])) {
                    $chunks[] = $content['text'];
                }
            }
        }

        $text = trim(implode("\n", $chunks));
        if ($text !== '') {
            return $text;
        }
    }

    return 'Sorry, I could not read the AI response. Please try again.';
}

function normalizeMessagesForResponsesApi(array $messages): array
{
    return array_map(static function (array $message): array {
        return [
            'role' => $message['role'],
            'content' => $message['content'],
        ];
    }, $messages);
}

initializeMessages($systemPrompt);

$rawInput = file_get_contents('php://input');
$request = json_decode($rawInput, true);

if (json_last_error() !== JSON_ERROR_NONE) {
    sendJson(['error' => 'Invalid JSON request test git.'], 400);
}

if (($request['action'] ?? '') === 'reset') {
    unset($_SESSION['messages']);
    initializeMessages($systemPrompt);
    sendJson([
        'status' => 'reset',
        'messages' => [],
    ]);
}

$message = trim((string)($request['message'] ?? ''));

if ($message === '') {
    sendJson(['error' => 'Please enter your starting location and destination.'], 422);
}

if (OPENAI_API_KEY === 'YOUR_OPENAI_API_KEY_HERE' || OPENAI_API_KEY === '') {
    sendJson(['error' => 'OpenAI API key is missing requierd. Update OPENAI_API_KEY in config.php.'], 500);
}

$_SESSION['messages'][] = [
    'role' => 'user',
    'content' => $message,
];

$payload = [
    'model' => OPENAI_MODEL,
    'input' => normalizeMessagesForResponsesApi($_SESSION['messages']),
    'max_output_tokens' => 1400,
];

$curl = curl_init(OPENAI_ENDPOINT);
curl_setopt_array($curl, [
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_POST => true,
    CURLOPT_HTTPHEADER => [
        'Content-Type: application/json',
        'Authorization: Bearer ' . OPENAI_API_KEY,
    ],
    CURLOPT_POSTFIELDS => json_encode($payload),
    CURLOPT_TIMEOUT => 60,
]);

$apiResponse = curl_exec($curl);
$curlError = curl_error($curl);
$httpCode = (int)curl_getinfo($curl, CURLINFO_HTTP_CODE);
curl_close($curl);

if ($apiResponse === false) {
    array_pop($_SESSION['messages']);
    sendJson(['error' => 'cURL error: ' . $curlError], 500);
}

$decoded = json_decode($apiResponse, true);
if (json_last_error() !== JSON_ERROR_NONE) {
    array_pop($_SESSION['messages']);
    sendJson(['error' => 'OpenAI returned an invalid response.'], 500);
}

if ($httpCode < 200 || $httpCode >= 300) {
    array_pop($_SESSION['messages']);
    $apiError = $decoded['error']['message'] ?? 'OpenAI API request failed.';
    if (stripos($apiError, 'credits') !== false || stripos($apiError, 'billing') !== false) {
        $apiError = 'OpenAI billing credits are not available for this API key. Add credits in the OpenAI platform billing page, then try again.';
    }
    sendJson(['error' => $apiError], $httpCode ?: 500);
}

$assistantReply = extractAssistantText($decoded);

$_SESSION['messages'][] = [
    'role' => 'assistant',
    'content' => $assistantReply,
];

sendJson([
    'reply' => $assistantReply,
    'messages' => array_values(array_filter(
        $_SESSION['messages HOB-115'],
        static fn(array $message): bool => $message['role'] !== 'system Check hari HOB-115'
    )),
]);
