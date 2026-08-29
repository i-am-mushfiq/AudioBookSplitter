param([switch]$Apply)

$ErrorActionPreference = "Stop"
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$localRoot = Join-Path $projectRoot "local-data"
$destinationRoot = Join-Path $localRoot "books"

if ($projectRoot -ne "C:\Personal_Endeavours\BookSync2") {
    throw "Unexpected workspace: $projectRoot"
}

function Move-WorkspaceItem([string]$relativeSource, [string]$relativeDestination) {
    $source = Join-Path $projectRoot $relativeSource
    $destination = Join-Path $projectRoot $relativeDestination
    if (-not (Test-Path -LiteralPath $source)) {
        throw "Missing source: $relativeSource"
    }
    if (Test-Path -LiteralPath $destination) {
        throw "Destination already exists: $relativeDestination"
    }
    $resolvedSource = (Resolve-Path -LiteralPath $source).Path
    if (-not $resolvedSource.StartsWith($localRoot + "\")) {
        throw "Source is outside local-data: $resolvedSource"
    }
    Write-Output ("{0} -> {1}" -f $relativeSource, $relativeDestination)
    if (-not $Apply) { return }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
    Move-Item -LiteralPath $resolvedSource -Destination $destination
}

function Ensure-BookFolder([string]$relativeFolder) {
    $destination = Join-Path $projectRoot $relativeFolder
    if ($Apply) { New-Item -ItemType Directory -Force -Path $destination | Out-Null }
}

$uploadedRoot = "local-data\books\in-hugging-face"
$completeRoot = "local-data\books\not-in-hugging-face\complete"
$partialRoot = "local-data\books\not-in-hugging-face\partial"
$unprocessedRoot = "local-data\books\not-in-hugging-face\unprocessed"
$operationsRoot = "local-data\books\_operations"

$books = @(
    @{
        Folder = "$uploadedRoot\Animal_Farm"
        Moves = @(
            @{ From = "local-data\book-pairs\fixtures\test1\Animal Farm (George Orwell) (z-library.sk, 1lib.sk, z-lib.sk).epub"; To = "Animal Farm (George Orwell) (z-library.sk, 1lib.sk, z-lib.sk).epub" },
            @{ From = "local-data\book-pairs\fixtures\test1\orwellanimalfarm.pdf"; To = "orwellanimalfarm.pdf" },
            @{ From = "local-data\book-pairs\fixtures\test1\George Orwell Collection - Animal Farm Audiobook.mp3"; To = "George Orwell Collection - Animal Farm Audiobook.mp3" },
            @{ From = "local-data\generated\test1-output"; To = "generated\test1-output" },
            @{ From = "local-data\generated\test1-ios-output"; To = "generated\test1-ios-output" },
            @{ From = "local-data\generated\test1-milestone1-output"; To = "generated\test1-milestone1-output" },
            @{ From = "local-data\generated\test1-milestone2-output"; To = "generated\test1-milestone2-output" }
        )
    },
    @{
        Folder = "$uploadedRoot\Adult_Children_of_Emotionally_Immature_Parents"
        Moves = @(
            @{ From = "local-data\book-pairs\inbox\To-be-done\Adult Children of Emotionally Immature Parents (Lindsay C. Gibson) (z-library.sk, 1lib.sk, z-lib.sk).epub"; To = "Adult Children of Emotionally Immature Parents (Lindsay C. Gibson) (z-library.sk, 1lib.sk, z-lib.sk).epub" },
            @{ From = "local-data\book-pairs\inbox\To-be-done\Adult Children of Emotionally Immature Parents꞉ How to Heal from Distant, Rejecting, or Self-Involved Parents.m4b"; To = "Adult Children of Emotionally Immature Parents꞉ How to Heal from Distant, Rejecting, or Self-Involved Parents.m4b" },
            @{ From = "local-data\book-pairs\inbox\To-be-done\processed\Adult_Children_of_Emotionally_Immature_Parents"; To = "processing" }
        )
    },
    @{
        Folder = "$uploadedRoot\One_Hundred_Years_of_Solitude"
        Moves = @(
            @{ From = "local-data\book-pairs\newnew\One Hundred Years of Solitude (Gabriel Garcia Marquez) (z-library.sk, 1lib.sk, z-lib.sk).epub"; To = "One Hundred Years of Solitude (Gabriel Garcia Marquez) (z-library.sk, 1lib.sk, z-lib.sk).epub" },
            @{ From = "local-data\book-pairs\newnew\One Hundred Years of Solitude"; To = "One Hundred Years of Solitude" },
            @{ From = "local-data\book-pairs\newnew\.covers\One_Hundred_Years_of_Solitude.jpg"; To = "One_Hundred_Years_of_Solitude.jpg" },
            @{ From = "local-data\book-pairs\newnew\processed\One_Hundred_Years_of_Solitude"; To = "processing" }
        )
    },
    @{
        Folder = "$uploadedRoot\The_Innovator_s_Dilemma"
        Moves = @(
            @{ From = "local-data\book-pairs\newnew\The Innovators Dilemma When New Technologies Cause Great Firms to Fail (Management of Innovation and Change) (Clayton M. Christensen) (z-library.sk, 1lib.sk, z-lib.sk).epub"; To = "The Innovators Dilemma When New Technologies Cause Great Firms to Fail (Management of Innovation and Change) (Clayton M. Christensen) (z-library.sk, 1lib.sk, z-lib.sk).epub" },
            @{ From = "local-data\book-pairs\newnew\The Innovator's Dilemma"; To = "The Innovator's Dilemma" },
            @{ From = "local-data\book-pairs\newnew\processed\The_Innovator_s_Dilemma"; To = "processing" }
        )
    },
    @{
        Folder = "$uploadedRoot\Thinking_Fast_and_Slow"
        Moves = @(
            @{ From = "local-data\book-pairs\newnew\Thinking, Fast and Slow (Daniel Kahneman) (z-library.sk, 1lib.sk, z-lib.sk).epub"; To = "Thinking, Fast and Slow (Daniel Kahneman) (z-library.sk, 1lib.sk, z-lib.sk).epub" },
            @{ From = "local-data\book-pairs\newnew\Thinking, Fast and Slow"; To = "Thinking, Fast and Slow" },
            @{ From = "local-data\book-pairs\newnew\.covers\Thinking_Fast_and_Slow.jpg"; To = "Thinking_Fast_and_Slow.jpg" },
            @{ From = "local-data\book-pairs\newnew\processed\Thinking_Fast_and_Slow"; To = "processing" }
        )
    },
    @{
        Folder = "$uploadedRoot\All_the_Light_We_Cannot_See"
        Moves = @(
            @{ From = "local-data\book-pairs\newnewnew\All The Light We Cannot See (Anthony Doerr) (z-library.sk, 1lib.sk, z-lib.sk).epub"; To = "All The Light We Cannot See (Anthony Doerr) (z-library.sk, 1lib.sk, z-lib.sk).epub" },
            @{ From = "local-data\book-pairs\newnewnew\All the Light We Cannot See"; To = "All the Light We Cannot See" },
            @{ From = "local-data\book-pairs\newnewnew\processed\All_the_Light_We_Cannot_See"; To = "processing" }
        )
    },
    @{
        Folder = "$uploadedRoot\Sapiens"
        Moves = @(
            @{ From = "local-data\book-pairs\newnewnew\Sapiens A Brief History of Humankind (Yuval Noah Harari) (z-library.sk, 1lib.sk, z-lib.sk).epub"; To = "Sapiens A Brief History of Humankind (Yuval Noah Harari) (z-library.sk, 1lib.sk, z-lib.sk).epub" },
            @{ From = "local-data\book-pairs\newnewnew\Sapiens"; To = "Sapiens" },
            @{ From = "local-data\book-pairs\newnewnew\.covers\Sapiens.jpg"; To = "Sapiens.jpg" },
            @{ From = "local-data\book-pairs\newnewnew\processed\Sapiens"; To = "processing" }
        )
    },
    @{
        Folder = "$uploadedRoot\The_Pragmatic_Programmer"
        Moves = @(
            @{ From = "local-data\book-pairs\newnewnew\The Pragmatic Programmer (David ThomasAndrew Hunt) (z-library.sk, 1lib.sk, z-lib.sk).epub"; To = "The Pragmatic Programmer (David ThomasAndrew Hunt) (z-library.sk, 1lib.sk, z-lib.sk).epub" },
            @{ From = "local-data\book-pairs\newnewnew\The Pragmatic Programmer"; To = "The Pragmatic Programmer" },
            @{ From = "local-data\book-pairs\newnewnew\.covers\The_Pragmatic_Programmer.jpg"; To = "The_Pragmatic_Programmer.jpg" },
            @{ From = "local-data\book-pairs\newnewnew\processed\The_Pragmatic_Programmer"; To = "processing" }
        )
    },
    @{
        Folder = "$uploadedRoot\The_Book_Thief"
        Moves = @(
            @{ From = "local-data\book-pairs\newnewnew\The Book Thief (Markus Zusak) (z-library.sk, 1lib.sk, z-lib.sk).epub"; To = "The Book Thief (Markus Zusak) (z-library.sk, 1lib.sk, z-lib.sk).epub" },
            @{ From = "local-data\book-pairs\newnewnew\The Book Thief"; To = "The Book Thief" },
            @{ From = "local-data\book-pairs\newnewnew\processed\The_Book_Thief"; To = "processing" }
        )
    },
    @{
        Folder = "$completeRoot\A_Spy_Among_Friends"
        Moves = @(
            @{ From = "local-data\book-pairs\newnewnew\A Spy Among Friends (Ben Macintyre) (z-library.sk, 1lib.sk, z-lib.sk).epub"; To = "A Spy Among Friends (Ben Macintyre) (z-library.sk, 1lib.sk, z-lib.sk).epub" },
            @{ From = "local-data\book-pairs\newnewnew\A Spy Among Friends"; To = "A Spy Among Friends" },
            @{ From = "local-data\book-pairs\newnewnew\.combined\A_Spy_Among_Friends.mp3"; To = "prepared-audio\A_Spy_Among_Friends.mp3" },
            @{ From = "local-data\book-pairs\newnewnew\processed\A_Spy_Among_Friends"; To = "processing" }
        )
    },
    @{
        Folder = "$completeRoot\Man_s_Search_for_Meaning"
        Moves = @(
            @{ From = 'local-data\book-pairs\newnewnew\Man`s Search for Meaning (Viktor E. Frankl) (z-library.sk, 1lib.sk, z-lib.sk).epub'; To = 'Man`s Search for Meaning (Viktor E. Frankl) (z-library.sk, 1lib.sk, z-lib.sk).epub' },
            @{ From = "local-data\book-pairs\newnewnew\Man's Search for Meaning"; To = "Man's Search for Meaning" },
            @{ From = "local-data\book-pairs\newnewnew\.combined\Mans_Search_for_Meaning.mp3"; To = "prepared-audio\Mans_Search_for_Meaning.mp3" },
            @{ From = "local-data\book-pairs\newnewnew\processed\Man_s_Search_for_Meaning"; To = "processing" }
        )
    },
    @{
        Folder = "$completeRoot\The_Death_of_Ivan_Ilyich"
        Moves = @(
            @{ From = "local-data\book-pairs\newnewnew\The Death of Ivan Ilyich (Leo Tolstoy) (z-library.sk, 1lib.sk, z-lib.sk).epub"; To = "The Death of Ivan Ilyich (Leo Tolstoy) (z-library.sk, 1lib.sk, z-lib.sk).epub" },
            @{ From = "local-data\book-pairs\newnewnew\The Death of Ivan Ilyich"; To = "The Death of Ivan Ilyich" },
            @{ From = "local-data\book-pairs\newnewnew\.combined\The_Death_of_Ivan_Ilyich.m4b"; To = "prepared-audio\The_Death_of_Ivan_Ilyich.m4b" },
            @{ From = "local-data\book-pairs\newnewnew\processed\The_Death_of_Ivan_Ilyich"; To = "processing" }
        )
    },
    @{
        Folder = "$unprocessedRoot\Attached"
        Moves = @(
            @{ From = "local-data\book-pairs\fixtures\test2\Attached (Amir Levine, Rachel Heller) (z-library.sk, 1lib.sk, z-lib.sk).epub"; To = "Attached (Amir Levine, Rachel Heller) (z-library.sk, 1lib.sk, z-lib.sk).epub" },
            @{ From = "local-data\book-pairs\fixtures\test2\AttachedTheNewScienceofAdultAttachmentandHowItCanHelpYouFind-andKeep-LoveUnabridged_ep6.mp3"; To = "AttachedTheNewScienceofAdultAttachmentandHowItCanHelpYouFind-andKeep-LoveUnabridged_ep6.mp3" },
            @{ From = "local-data\book-pairs\inbox\To-be-done\Attached (Amir Levine, Rachel Heller) (z-library.sk, 1lib.sk, z-lib.sk)(1).epub"; To = "alternate-copy\Attached (Amir Levine, Rachel Heller) (z-library.sk, 1lib.sk, z-lib.sk)(1).epub" },
            @{ From = "local-data\book-pairs\inbox\To-be-done\AttachedTheNewScienceofAdultAttachmentandHowItCanHelpYouFind-andKeep-LoveUnabridged_ep6.mp3"; To = "alternate-copy\AttachedTheNewScienceofAdultAttachmentandHowItCanHelpYouFind-andKeep-LoveUnabridged_ep6.mp3" },
            @{ From = "local-data\generated\test2-output"; To = "generated\test2-output" }
        )
    },
    @{
        Folder = "$unprocessedRoot\Designing_Data_Intensive_Applications"
        Moves = @(
            @{ From = "local-data\book-pairs\inbox\To-be-done\Martin Kleppmann - Designing Data-Intensive Applications The Big Ideas Behind Reliable, Scalable, and Maintainable Systems.epub"; To = "Martin Kleppmann - Designing Data-Intensive Applications The Big Ideas Behind Reliable, Scalable, and Maintainable Systems.epub" },
            @{ From = "local-data\book-pairs\inbox\To-be-done\Martin Kleppmann - Designing Data-Intensive Applications The Big Ideas Behind Reliable, Scalable, and Maintainable Systems.mp3"; To = "Martin Kleppmann - Designing Data-Intensive Applications The Big Ideas Behind Reliable, Scalable, and Maintainable Systems.mp3" }
        )
    },
    @{
        Folder = "$unprocessedRoot\Influence"
        Moves = @(
            @{ From = "local-data\book-pairs\newnewnew\Influence (Robert B. Cialdini, PhD) (z-library.sk, 1lib.sk, z-lib.sk).epub"; To = "Influence (Robert B. Cialdini, PhD) (z-library.sk, 1lib.sk, z-lib.sk).epub" },
            @{ From = "local-data\book-pairs\newnewnew\Influence"; To = "Influence" }
        )
    },
    @{
        Folder = "$unprocessedRoot\The_Intelligent_Investor"
        Moves = @(
            @{ From = "local-data\book-pairs\newnewnew\The Intelligent Investor The Definitive Book On Value Investing, Revised Edition (Benjamin Graham, Jason Zweig) (z-library.sk, 1lib.sk, z-lib.sk).epub"; To = "The Intelligent Investor The Definitive Book On Value Investing, Revised Edition (Benjamin Graham, Jason Zweig) (z-library.sk, 1lib.sk, z-lib.sk).epub" },
            @{ From = "local-data\book-pairs\newnewnew\The Intelligent Investor"; To = "The Intelligent Investor" }
        )
    },
    @{
        Folder = "$unprocessedRoot\The_Spy_and_the_Traitor"
        Moves = @(
            @{ From = "local-data\book-pairs\newnewnew\The Spy and the Traitor (Ben MacIntyre) (z-library.sk, 1lib.sk, z-lib.sk).epub"; To = "The Spy and the Traitor (Ben MacIntyre) (z-library.sk, 1lib.sk, z-lib.sk).epub" },
            @{ From = "local-data\book-pairs\newnewnew\The Spy and the Traitor"; To = "The Spy and the Traitor" }
        )
    },
    @{
        Folder = "$unprocessedRoot\Why_Machines_Learn"
        Moves = @(
            @{ From = "local-data\book-pairs\newnewnew\Why Machines Learn The Elegant Maths Behind Modern AI (Anil Ananthaswamy) (z-library.sk, 1lib.sk, z-lib.sk).epub"; To = "Why Machines Learn The Elegant Maths Behind Modern AI (Anil Ananthaswamy) (z-library.sk, 1lib.sk, z-lib.sk).epub" },
            @{ From = "local-data\book-pairs\newnewnew\Why Machines Learn"; To = "Why Machines Learn" }
        )
    }
)

foreach ($book in $books) {
    Ensure-BookFolder $book.Folder
    foreach ($move in $book.Moves) {
        Move-WorkspaceItem $move.From (Join-Path $book.Folder $move.To)
    }
}

if ($Apply) {
    New-Item -ItemType Directory -Force -Path (Join-Path $projectRoot $partialRoot), (Join-Path $projectRoot $operationsRoot) | Out-Null
}

# Preserve queue logs and legacy scripts as operational history after all book
# data has been extracted from the old collection layout.
Move-WorkspaceItem "local-data\book-pairs\newnew" "$operationsRoot\legacy-newnew"
Move-WorkspaceItem "local-data\book-pairs\newnewnew" "$operationsRoot\legacy-newnewnew"
Move-WorkspaceItem "local-data\book-pairs\fixtures" "$operationsRoot\legacy-fixtures"
Move-WorkspaceItem "local-data\book-pairs\inbox" "$operationsRoot\legacy-inbox"
Move-WorkspaceItem "local-data\book-pairs" "$operationsRoot\legacy-book-pairs-layout"
Move-WorkspaceItem "local-data\generated" "$operationsRoot\legacy-generated-layout"

Write-Output "Mode: $(if ($Apply) { 'APPLIED' } else { 'DRY RUN' })"
Write-Output "Books classified: $($books.Count)"
