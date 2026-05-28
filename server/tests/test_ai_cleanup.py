from app.ai_cleanup import Word, suggest_cuts_from_words


def test_repeated_word_keeps_first_and_cuts_rest() -> None:
    words = [
        Word("Trabo", "trabo", 0.10, 0.35),
        Word("trabo", "trabo", 0.52, 0.78),
        Word("trabo", "trabo", 0.92, 1.16),
        Word("bien", "bien", 1.70, 1.96),
    ]

    cuts = suggest_cuts_from_words(words)

    assert len(cuts) == 1
    assert cuts[0].start < 0.52
    assert cuts[0].end > 1.16
    assert "Palabra repetida: Trabo x3" == cuts[0].reason


def test_repeated_phrase_keeps_first_phrase_and_cuts_duplicates() -> None:
    words = [
        Word("me", "me", 0.00, 0.10),
        Word("trabo", "trabo", 0.12, 0.42),
        Word("me", "me", 0.68, 0.80),
        Word("trabo", "trabo", 0.82, 1.10),
        Word("me", "me", 1.24, 1.36),
        Word("trabo", "trabo", 1.40, 1.66),
        Word("ahora", "ahora", 2.20, 2.46),
    ]

    cuts = suggest_cuts_from_words(words)

    assert len(cuts) == 1
    assert cuts[0].start < 0.68
    assert cuts[0].end > 1.66
    assert cuts[0].reason == "Frase repetida: me trabo"
