/* Where the tracing pages send their work: a Google Apps Script web app that saves
   into the "A4 tracing submissions" Drive folder. url = "" turns sending off (the
   page falls back to "download the file and attach it to an email"). The key is a
   spam filter shared with the receiver script, not a secret. */
window.A4_RECEIVER = {
  url: 'https://script.google.com/macros/s/AKfycbwoYYT0C6ptfdj31xUYSRkq5fSqiborbB4zqDyIJqBLYG-R76twZjjQFfTozpfSFxzF2Q/exec',
  key: 'a4t-7Qm2xV9pL4'
};
