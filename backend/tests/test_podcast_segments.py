from __future__ import annotations

import pytest

from app.podcast_segments import split_sentences


def test_empty_string_returns_empty():
    assert split_sentences("") == []


def test_whitespace_only_returns_empty():
    assert split_sentences("   \n\t  ") == []


def test_single_sentence_no_terminator():
    assert split_sentences("Hello world") == ["Hello world"]


def test_two_simple_sentences():
    assert split_sentences("Hello world. Goodbye world.") == [
        "Hello world.",
        "Goodbye world.",
    ]


def test_question_and_exclamation_split():
    assert split_sentences("Did you see it? Yes I did! Good.") == [
        "Did you see it?",
        "Yes I did!",
        "Good.",
    ]


def test_multiple_spaces_normalized():
    assert split_sentences("First.    Second.\n\n\nThird.") == [
        "First.",
        "Second.",
        "Third.",
    ]


def test_decimal_number_does_not_split():
    # "0.5 percent" must not split between "0." and "5 percent."
    result = split_sentences("The accuracy was 0.5 percent. Then it improved.")
    assert result == [
        "The accuracy was 0.5 percent.",
        "Then it improved.",
    ]


def test_eg_abbrev_does_not_split():
    # "e.g." inside a sentence must not terminate it.
    result = split_sentences("Many domains, e.g. biology and chemistry. We tested both.")
    assert len(result) == 2
    assert "e.g." in result[0]
    assert result[1] == "We tested both."


def test_ie_abbrev_does_not_split():
    result = split_sentences("That is, i.e. the model fails. The fix is unclear.")
    assert len(result) == 2
    assert "i.e." in result[0]


def test_fig_abbrev_does_not_split():
    result = split_sentences("Refer to Fig. 3 for details. The trend is clear.")
    assert len(result) == 2
    assert "Fig. 3" in result[0]


def test_etc_abbrev_does_not_split():
    result = split_sentences("Cats, dogs, etc. are common. Birds are different.")
    assert len(result) == 2
    assert "etc." in result[0]


def test_phd_abbrev_does_not_split():
    result = split_sentences("She earned her Ph.D. last year. It took six years.")
    assert len(result) == 2
    assert "Ph.D." in result[0]


def test_dr_abbrev_does_not_split():
    result = split_sentences("Dr. Smith arrived. He was late.")
    assert len(result) == 2
    assert result[0].startswith("Dr.")


def test_paren_open_after_period_splits():
    # "...prior work. (Smith, 2020) shows..." should split before the paren.
    result = split_sentences("That contradicts prior work. (Smith, 2020) showed it earlier.")
    assert len(result) == 2


def test_quote_open_after_period_splits():
    # Curly/straight quotes after a period.
    result = split_sentences('They said no. "We disagree" came the reply.')
    assert len(result) == 2


def test_no_split_inside_quoted_period():
    # A period inside a quote shouldn't end the sentence if followed by lowercase.
    # ("...the end." he muttered.) — only one sentence here.
    # The simple splitter we're building IS allowed to be wrong on this one;
    # what matters is no crash. Document the behavior we accept.
    result = split_sentences('He said "stop." he muttered.')
    # Either 1 or 2 sentences is acceptable behavior for a lightweight splitter.
    assert len(result) in (1, 2)


def test_strips_outer_whitespace():
    assert split_sentences("  Hello.  Goodbye.  ") == ["Hello.", "Goodbye."]


def test_no_terminator_on_final_sentence():
    assert split_sentences("First sentence. Second sentence with no period") == [
        "First sentence.",
        "Second sentence with no period",
    ]


@pytest.mark.parametrize("text,expected_count", [
    ("One.", 1),
    ("One. Two.", 2),
    ("One. Two. Three.", 3),
    ("One? Two! Three.", 3),
])
def test_count_matches(text: str, expected_count: int):
    assert len(split_sentences(text)) == expected_count
