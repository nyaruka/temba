import gzip
import json
from datetime import datetime, timezone as tzone

import regex
from boto3.dynamodb.types import Binary

from temba.tests.dates import FULL_ISO8601_REGEX, ISO_YYYY_MM_DD

UUID_REGEX = {
    4: regex.compile(r"[a-f0-9]{8}-?[a-f0-9]{4}-?4[a-f0-9]{3}-?[89ab][a-f0-9]{3}-?[a-f0-9]{12}", regex.IGNORECASE),
    7: regex.compile(r"[a-f0-9]{8}-?[a-f0-9]{4}-?7[a-f0-9]{3}-?[89ab][a-f0-9]{3}-?[a-f0-9]{12}", regex.IGNORECASE),
}


class MatcherMixin:
    def __ne__(self, other):
        return not self.__eq__(other)

    def __repr__(self):
        return "<Any:%s>" % self.__class__.__name__


class String(MatcherMixin, str):
    def __new__(cls, pattern=None):
        s = str.__new__(cls, "xxx")
        s.pattern = pattern
        return s

    def __eq__(self, other):
        if not isinstance(other, str):
            return False
        if self.pattern and not regex.match(self.pattern, other):
            return False
        return True

    def __repr__(self):
        return f"<Any:String:pattern={self.pattern}>" if self.pattern is not None else super().__repr__()


class ISODate(String):
    """
    Matches any ISO8601 formatted date string
    """

    def __new__(cls):
        return super().__new__(cls, pattern=ISO_YYYY_MM_DD)


class ISODatetime(String):
    """
    Matches any ISO8601 formatted datetime string
    """

    def __new__(cls):
        return super().__new__(cls, pattern=FULL_ISO8601_REGEX)


class UUIDString(String):
    """
    Matches any UUID v4 string
    """

    def __new__(cls, version: int):
        v = super().__new__(cls, pattern=UUID_REGEX[version])
        v.version = version
        return v

    def __repr__(self):
        return f"<Any:UUIDString:version={self.version}>"


class List(MatcherMixin, list):
    """
    Matches any list or any list of a given length
    """

    def __new__(cls, length=None):
        v = list.__new__(cls, [])
        v.length = length
        return v

    def __eq__(self, other):
        if not isinstance(other, list):
            return False
        if self.length and not len(other) == self.length:
            return False
        return True

    def __repr__(self):
        return f"<Any:List:length={self.length}>" if self.length is not None else super().__repr__()


class Dict(MatcherMixin, dict):
    """
    Matches any dict
    """

    def __eq__(self, other):
        return isinstance(other, dict)


class Datetime(MatcherMixin, datetime):
    """
    Matches any datetime
    """

    def __new__(cls):
        return datetime.__new__(cls, 2019, 10, 30, 13, 39, 30, 123456, tzone.utc)

    def __eq__(self, other):
        return isinstance(other, datetime)


class Int(MatcherMixin, int):
    """
    Matches any int
    """

    def __new__(cls, min=None):
        m = int.__new__(cls, 0)
        m.min = min
        return m

    def __eq__(self, other):
        if not isinstance(other, int):
            return False
        if self.min is not None and other < self.min:
            return False
        return True


class Float(MatcherMixin, float):
    """
    Matches any float
    """

    def __new__(cls, min=None):
        m = float.__new__(cls, 0)
        m.min = min
        return m

    def __eq__(self, other):
        if not isinstance(other, float):
            return False
        if self.min is not None and other < self.min:
            return False
        return True


class GZippedJSON(MatcherMixin):
    """
    Matches a gzipped JSON payload (as bytes or DynamoDB Binary) whose decoded value equals the given payload.
    """

    def __init__(self, payload):
        self.payload = payload

    def __eq__(self, other):
        if isinstance(other, Binary):
            other = bytes(other)
        if not isinstance(other, (bytes, bytearray)):
            return False
        try:
            decoded = json.loads(gzip.decompress(other).decode("utf-8"))
        except OSError, ValueError:
            return False
        return decoded == self.payload

    def __repr__(self):
        return f"<Any:GZippedJSON:payload={self.payload!r}>"
