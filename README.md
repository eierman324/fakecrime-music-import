> [!WARNING]
> Every file in this repository – code, README, everything – was written by Claude (Anthropic's AI). No line was written by a human. Use at your own risk.

# fakecrime-music-import

Unofficial Tampermonkey script for [fakecrime.bio](https://fakecrime.bio). It lets you add songs to
your bio's music player straight from **SoundCloud** or **YouTube** – paste a link or just type the
song name, and the *Create Song* form is filled in for you. It also adds an image and audio search
to the upload fields.

Nothing is submitted automatically: you review the form and press **Create** yourself.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) in your browser.
2. **[Click here to install the script](https://github.com/e1erman/fakecrime-music-import/releases/latest/download/fakecrime-music-import.user.js)**
   and confirm with *Install* in the Tampermonkey dialog.
3. Open (or reload) <https://fakecrime.bio/bio/music>.

Tampermonkey checks for new versions automatically and updates the script whenever a new
[release](https://github.com/e1erman/fakecrime-music-import/releases) is published.
To check right away: click the Tampermonkey icon → *Check for userscript updates*.

The first time the script loads something, Tampermonkey asks whether it may connect to that site
(SoundCloud, YouTube, Google, and the hosts of images you pick). Choose **Always allow** – or
**Always allow all domains**, since image search results can come from any site.

## Usage

### Add from SoundCloud / YouTube

On the **Music** page there's a new **Add from SoundCloud / YouTube** button next to *Create*.
It opens a popup:

- **Paste a link** – SoundCloud (`soundcloud.com/…`, `on.soundcloud.com/…`) or YouTube
  (`youtube.com/watch?v=…`, `youtu.be/…`, Shorts, YouTube Music). It's loaded right away.
- **Or type a song name** – results appear while you type. Switch between the *SoundCloud* and
  *YouTube* tab; the script remembers your choice.

Picking a track fills the whole form:

| Field | Value |
|---|---|
| Audio | The track's audio (MP3 or MP4/AAC) |
| Cover | SoundCloud artwork, or the YouTube thumbnail cropped to 1:1 (black bars removed) |
| Background | Optional: the cover again (checkbox in the popup) |
| Name | `Title - Artist` |
| URL | The SoundCloud / YouTube link |

For YouTube, the name is taken from the video title: `Artist - Title (Official Video)` becomes
`Title - Artist`. Without a ` - ` in the title, the channel name is used as the artist
(`- Topic` and `VEVO` are removed).

### Search in the upload fields

The *Cover*, *Background* and *Audio* fields now say **Drag a file here, browse or search**.

- **Cover / Background → search:** image search with tabs for **Google**, **SoundCloud** (track and
  album artwork), **Apple Music** (album covers up to 1200 px) and **YouTube** (thumbnails).
  You can also paste an image URL or a SoundCloud/YouTube link.
  Covers are cropped to a square automatically; backgrounds are kept as they are.
- **Audio → search:** the same as the main popup, but only the audio file is filled in.

If the *Name* field already has something in it, the search starts with that.

### Preview-only SoundCloud tracks

Some SoundCloud tracks (Go+) only offer a 30-second preview. They're marked
**preview · via YouTube** in the results: the script then takes the full audio from the YouTube
video whose length matches best, and keeps cover, name and URL from SoundCloud.
If no matching video is found, the 30-second preview is used and the popup tells you.

## How it works

- **SoundCloud:** reads the public `client_id` from SoundCloud's web app (cached, refreshed when it
  expires) and uses `api-v2.soundcloud.com`. It picks the best unencrypted stream:
  progressive MP3 → HLS MP3 → HLS AAC → HLS Opus. HLS segments are joined in the browser.
- **YouTube:** uses YouTube's internal API with mobile/VR clients that return direct stream URLs,
  and downloads the M4A audio stream in chunks (falls back to the 360p MP4 if needed).
- **Google images** are read from the normal results page. If Google shows a consent page or a
  captcha, the script uses Bing instead and says so.
- The files are put into fakecrime's upload fields with the file types they accept
  (e.g. `video/mp4`), and the text fields are filled like you typed them.

## Limitations

- SoundCloud tracks that are only available as encrypted streams can't be downloaded.
- YouTube changes its internals regularly. If YouTube downloads stop working, the client list
  (`YT_PLAYER_CLIENTS`) in the script needs an update.
- fakecrime's limits still apply: audio ≤ 100 MB, cover ≤ 15 MB, background ≤ 100 MB,
  name ≤ 100 characters, URL ≤ 250 characters.
- If fakecrime changes its page layout, the field detection may need an update.

Only add music and images you have the right to use. This project is not affiliated with
fakecrime, SoundCloud, YouTube, Google or Apple.

## License

[MIT](LICENSE)
