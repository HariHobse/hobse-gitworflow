<?php
session_start();

$visibleMessages = [];
if (isset($_SESSION['messages']) && is_array($_SESSION['messages'])) {
    $visibleMessages = array_values(array_filter(
        $_SESSION['messages'],
        static fn(array $message): bool => ($message['role'] ?? '') !== 'system'
    ));
}
?>
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Hobse TripMate</title>
    <link rel="stylesheet" href="style.css">
</head>
<body>
    <main class="app-shell">
        <section class="chat-panel" aria-label="Hobse TripMate chatbot">
            <header class="chat-header">
                <div class="brand-lockup">
                    <div class="brand-mark">H</div>
                    <div class="brand-copy">
                        <p class="eyebrow">Hobse Travel AI</p>
                        <h1>Hobse TripMate</h1>
                        <p class="tagline">Corporate travel planning assistant</p>
                    </div>
                </div>
                <div class="header-actions">
                    <span class="status-pill">Advisor mode</span>
                    <button class="reset-button" id="resetChat" type="button">Reset</button>
                </div>
            </header>

            <div class="chat-window" id="chatWindow" aria-live="polite">
                <?php if (empty($visibleMessages)): ?>
                    <section class="welcome-state" id="welcomeState">
                        <div class="route-visual" aria-hidden="true">
                            <span class="pin pin-start"></span>
                            <span class="route-line"></span>
                            <span class="pin pin-end"></span>
                        </div>
                        <div class="welcome-copy">
                            <p class="welcome-kicker">New Trip Brief</p>
                            <h2>Enter source and destination</h2>
                            <p>Hobse TripMate will collect trip duration, traveller count, budget, travel mode, interests, and then prepare the itinerary.</p>
                        </div>
                        <div class="sample-routes" aria-label="Sample routes">
                            <button type="button" data-route="Chennai to Kanyakumari">Chennai to Kanyakumari</button>
                            <button type="button" data-route="Madurai to Rameswaram">Madurai to Rameswaram</button>
                            <button type="button" data-route="Coimbatore to Ooty">Coimbatore to Ooty</button>
                        </div>
                    </section>
                    <article class="message assistant">
                        <div class="avatar">HT</div>
                        <div class="message-body">
                            <div class="message-name">Hobse TripMate</div>
                            <div class="bubble">Hi, I am Hobse TripMate. Tell me your starting location and destination. For example: <strong>Chennai to Kanyakumari</strong>.</div>
                        </div>
                    </article>
                <?php else: ?>
                    <?php foreach ($visibleMessages as $message): ?>
                        <?php
                        $role = ($message['role'] ?? '') === 'user' ? 'user' : 'assistant';
                        $avatar = $role === 'user' ? 'You' : 'HT';
                        $content = htmlspecialchars((string)($message['content'] ?? ''), ENT_QUOTES, 'UTF-8');
                        ?>
                        <article class="message <?php echo $role; ?>">
                            <div class="avatar"><?php echo $avatar; ?></div>
                            <div class="message-body">
                                <div class="message-name"><?php echo $role === 'user' ? 'You' : 'Hobse TripMate'; ?></div>
                                <div class="bubble"><?php echo $content; ?></div>
                            </div>
                        </article>
                    <?php endforeach; ?>
                <?php endif; ?>
            </div>

            <form class="chat-form" id="chatForm">
                <div class="input-wrap">
                    <span class="input-label">Route</span>
                    <label class="sr-only" for="messageInput">Starting location and destination</label>
                    <input
                        id="messageInput"
                        type="text"
                        autocomplete="off"
                        placeholder="From Chennai to Kanyakumari"
                        required
                    >
                </div>
                <button type="submit">Send</button>
            </form>
        </section>
    </main>

    <script src="js/script.js"></script>
</body>
</html>
